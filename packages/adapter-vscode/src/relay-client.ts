import * as vscode from 'vscode';
import WebSocket = require('ws');
import type { ILogger } from '@mobile-copilot/adapter-core';
import type { VsCodeConfig } from './config';
import { E2ECrypto } from './e2e-crypto';

/**
 * Relay client — connects the VS Code extension to a cloud relay server
 * as the "host" side. All messages from the local RPC handler are forwarded
 * to remote mobile clients through the relay, and vice versa.
 *
 * E2E encryption: X25519 key exchange + XSalsa20-Poly1305 AEAD via tweetnacl.
 * The relay server sees only opaque ciphertext.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private roomCode: string | null = null;
  private hostSecret: string | null = null;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly e2e = new E2ECrypto();

  /** Fires when relay is connected and room is created */
  readonly onRoomCreated: vscode.EventEmitter<{ code: string }> = new vscode.EventEmitter();
  /** Fires when relay disconnects */
  readonly onDisconnected: vscode.EventEmitter<void> = new vscode.EventEmitter();
  /** Fires when a message arrives from a mobile client via relay */
  readonly onMessage: vscode.EventEmitter<string> = new vscode.EventEmitter();
  /** Fires when a mobile client joins the room */
  readonly onClientJoined: vscode.EventEmitter<{ clientCount: number }> = new vscode.EventEmitter();
  /** Fires when a mobile client leaves */
  readonly onClientLeft: vscode.EventEmitter<{ clientCount: number }> = new vscode.EventEmitter();

  constructor(
    private readonly logger: ILogger,
    private readonly config: VsCodeConfig,
  ) {}

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get code(): string | null {
    return this.roomCode;
  }

  /**
   * Connect to the relay server and create a room.
   */
  async connect(): Promise<string> {
    if (this.isConnected && this.roomCode) {
      return this.roomCode;
    }

    const relayUrl = (this.config.get<string>('relayUrl', '') ?? '').replace(/\/$/, '');
    if (!relayUrl) {
      throw new Error(
        'No relay URL configured. Set mobileCopilot.relayUrl in settings ' +
        '(e.g. wss://your-relay.example.com)'
      );
    }

    return new Promise((resolve, reject) => {
      const wsUrl = `${relayUrl}/relay/host`;
      this.logger.info(`[Relay] Connecting to ${wsUrl}`);

      try {
        this.ws = new WebSocket(wsUrl);
      } catch (err: any) {
        reject(new Error(`Failed to connect to relay: ${err.message}`));
        return;
      }

      const connectTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.terminate();
          reject(new Error('Relay connection timeout'));
        }
      }, 15_000);

      this.ws.on('open', () => {
        this.logger.info('[Relay] Connected, waiting for room code...');
      });

      this.ws.on('message', (data) => {
        const raw = data.toString();

        try {
          const msg = JSON.parse(raw);

          // Relay control messages
          if (msg.type === 'relay.room_created') {
            clearTimeout(connectTimeout);
            this.roomCode = msg.code;
            this.hostSecret = msg.hostSecret;
            this.reconnecting = false;
            this.logger.info(`[Relay] Room created: ${msg.code}`);
            this.onRoomCreated.fire({ code: msg.code });
            resolve(msg.code);
            return;
          }

          if (msg.type === 'relay.rejoined') {
            clearTimeout(connectTimeout);
            this.reconnecting = false;
            this.logger.info(`[Relay] Rejoined room: ${msg.code} (${msg.clientCount} clients)`);
            this.onRoomCreated.fire({ code: msg.code });
            resolve(msg.code);
            return;
          }

          if (msg.type === 'relay.client_joined') {
            this.logger.info(`[Relay] Client joined (${msg.clientCount} total)`);
            this.e2e.reset();   // new client → fresh key exchange
            this.onClientJoined.fire({ clientCount: msg.clientCount });
            return;
          }

          if (msg.type === 'relay.client_left') {
            this.logger.info(`[Relay] Client left (${msg.clientCount} remaining)`);
            this.onClientLeft.fire({ clientCount: msg.clientCount });
            return;
          }
        } catch {
          // Not valid JSON relay control — fall through
        }

        // Route through E2E handler (key exchange, decrypt, or passthrough)
        this.handleIncomingMessage(raw);
      });

      this.ws.on('close', (code, reason) => {
        clearTimeout(connectTimeout);
        this.logger.info(`[Relay] Disconnected: ${code} ${reason.toString()}`);
        this.ws = null;
        this.onDisconnected.fire();

        // Auto-reconnect if we have a room code and secret
        if (!this.disposed && this.roomCode && this.hostSecret) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        this.logger.error(`[Relay] Error: ${err.message}`);
        if (!this.roomCode) {
          reject(new Error(`Relay connection error: ${err.message}`));
        }
      });
    });
  }

  /**
   * Send a message to all connected mobile clients via the relay.
   * If E2E is established, the message is encrypted automatically.
   */
  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      if (this.e2e.isReady) {
        const encrypted = this.e2e.encrypt(data);
        this.logger.info(`[Relay] Sending encrypted (${encrypted.length} bytes, plaintext was ${data.length} bytes)`);
        this.ws.send(encrypted);
      } else {
        this.logger.info(`[Relay] Sending plaintext: ${data.substring(0, 200)}`);
        this.ws.send(data);
      }
    } else {
      this.logger.info(`[Relay] Cannot send — ws=${this.ws ? 'exists' : 'null'}, readyState=${this.ws?.readyState}`);
    }
  }

  /**
   * Disconnect from the relay and destroy the room.
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.roomCode = null;
    this.hostSecret = null;
    this.e2e.reset();

    if (this.ws) {
      this.ws.close(1000, 'Host disconnecting');
      this.ws = null;
    }

    this.logger.info('[Relay] Disconnected');
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.onRoomCreated.dispose();
    this.onDisconnected.dispose();
    this.onMessage.dispose();
    this.onClientJoined.dispose();
    this.onClientLeft.dispose();
  }

  // ─── E2E Encryption ──────────────────────────────────────

  /**
   * Handle an incoming message: key exchange, decrypt, or passthrough.
   * Called from BOTH the connect() and reconnect() message handlers.
   */
  private handleIncomingMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);

      // E2E key exchange initiated by mobile client
      if (msg.type === 'e2e.keyExchange' && msg.pubkey) {
        this.handleKeyExchange(msg.pubkey);
        return;
      }

      // E2E encrypted message — decrypt and forward plaintext
      if (msg.type === 'e2e.encrypted' && msg.n && msg.c) {
        try {
          const decrypted = this.e2e.decrypt(msg);
          this.logger.info(`[Relay] Decrypted E2E message (${decrypted.length} bytes)`);
          this.onMessage.fire(decrypted);
        } catch (err: any) {
          this.logger.error(`[Relay] E2E decryption failed: ${err.message}`);
        }
        return;
      }
    } catch {
      // Not valid JSON — fall through to plaintext passthrough
    }

    // Unencrypted message (pre-key-exchange or plain control message)
    this.logger.info(`[Relay] Forwarding plaintext message (${raw.length} bytes)`);
    this.onMessage.fire(raw);
  }

  /**
   * Complete the E2E key exchange: generate our key pair, send public key
   * back to the mobile client (plaintext), then derive the shared key.
   *
   * Order matters: send response BEFORE deriving shared key so the response
   * goes out unencrypted (the mobile hasn't derived the key yet either).
   */
  private handleKeyExchange(clientPubkeyBase64: string): void {
    this.logger.info('[Relay] E2E key exchange — received client public key');
    const hostPubkey = this.e2e.generateKeyPair();

    // Send our public key PLAINTEXT (before deriving shared key)
    const response = JSON.stringify({ type: 'e2e.keyExchange', pubkey: hostPubkey });
    this.ws!.send(response);

    // NOW derive the shared key — all future send() calls will encrypt
    this.e2e.deriveSharedKey(clientPubkeyBase64);
    this.logger.info('[Relay] E2E key exchange complete — all further messages encrypted');
  }

  // ─── Reconnection ──────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;

    const delayMs = 3000;
    this.logger.info(`[Relay] Reconnecting in ${delayMs / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.disposed) return;

      const relayUrl = (this.config.get<string>('relayUrl', '') ?? '').replace(/\/$/, '');
      if (!relayUrl || !this.roomCode || !this.hostSecret) {
        this.reconnecting = false;
        return;
      }

      const wsUrl = `${relayUrl}/relay/rejoin?code=${this.roomCode}&secret=${this.hostSecret}`;
      this.logger.info(`[Relay] Rejoining room ${this.roomCode}...`);

      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          this.logger.info('[Relay] Reconnected, waiting for rejoin confirmation...');
        });

        this.ws.on('message', (data) => {
          const raw = data.toString();
          try {
            const msg = JSON.parse(raw);

            if (msg.type === 'relay.rejoined') {
              this.reconnecting = false;
              this.e2e.reset();   // fresh key exchange after rejoin
              this.logger.info(`[Relay] Rejoined room: ${msg.code}`);
              this.onRoomCreated.fire({ code: msg.code });
              return;
            }

            if (msg.type === 'relay.client_joined') {
              this.e2e.reset();   // new client → fresh key exchange
              this.onClientJoined.fire({ clientCount: msg.clientCount });
              return;
            }

            if (msg.type === 'relay.client_left') {
              this.onClientLeft.fire({ clientCount: msg.clientCount });
              return;
            }
          } catch {
            // fall through
          }

          // Route through E2E handler (key exchange, decrypt, or passthrough)
          this.handleIncomingMessage(raw);
        });

        this.ws.on('close', (code, reason) => {
          this.logger.info(`[Relay] Disconnected again: ${code} ${reason.toString()}`);
          this.ws = null;
          this.onDisconnected.fire();
          this.reconnecting = false;

          if (!this.disposed && this.roomCode && this.hostSecret) {
            this.scheduleReconnect();
          }
        });

        this.ws.on('error', (err) => {
          this.logger.error(`[Relay] Reconnect error: ${err.message}`);
          this.reconnecting = false;
        });
      } catch (err: any) {
        this.logger.error(`[Relay] Reconnect failed: ${err.message}`);
        this.reconnecting = false;
        this.scheduleReconnect();
      }
    }, delayMs);
  }
}
