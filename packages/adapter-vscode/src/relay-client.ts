import * as vscode from 'vscode';
import WebSocket = require('ws');
import type { ILogger } from '@mobile-copilot/adapter-core';
import type { VsCodeConfig } from './config';

/**
 * Relay client — connects the VS Code extension to a cloud relay server
 * as the "host" side. All messages from the local RPC handler are forwarded
 * to remote mobile clients through the relay, and vice versa.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private roomCode: string | null = null;
  private hostSecret: string | null = null;
  private reconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

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

    const relayUrl = this.config.get<string>('relayUrl', '').replace(/\/$/, '');
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

        // Everything else is a message from a mobile client — forward to local handler
        this.onMessage.fire(raw);
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
   */
  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
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

  // ─── Reconnection ──────────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.reconnecting || this.disposed) return;
    this.reconnecting = true;

    const delayMs = 3000;
    this.logger.info(`[Relay] Reconnecting in ${delayMs / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.disposed) return;

      const relayUrl = this.config.get<string>('relayUrl', '').replace(/\/$/, '');
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
              this.logger.info(`[Relay] Rejoined room: ${msg.code}`);
              this.onRoomCreated.fire({ code: msg.code });
              return;
            }

            if (msg.type === 'relay.client_joined') {
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

          this.onMessage.fire(raw);
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
