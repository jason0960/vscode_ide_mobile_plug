/**
 * JSON-RPC client for Mobile Copilot.
 * Matches the protocol in @mobile-copilot/protocol.
 */

import { ConnectionManager } from './connection';

export interface RpcMessage {
  id: string;
  type: 'request' | 'response' | 'stream' | 'event' | 'error';
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type EventHandler = (method: string, params: any) => void;
type StreamChunkHandler = (id: string, chunk: string) => void;

interface PendingRequest {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  onChunk?: (chunk: string) => void;
  streamBuffer?: string;
}

let _idCounter = 0;
function genId(): string {
  return `rn_${Date.now()}_${++_idCounter}`;
}

export class RpcClient {
  private pending = new Map<string, PendingRequest>();
  private conn: ConnectionManager;

  public onEvent: EventHandler = () => {};
  public onStreamChunk: StreamChunkHandler = () => {};

  constructor(connection: ConnectionManager) {
    this.conn = connection;
    this.conn.onMessage = (raw: string) => this.handleMessage(raw);
  }

  /**
   * Handle relay control messages and forward RPC messages.
   * Returns true if the message was a relay control message.
   */
  handleRelayMessage(msg: any): boolean {
    if (msg.type === 'relay.joined') {
      console.log('[Relay] Joined room:', msg.code, 'hostConnected:', msg.hostConnected);
      if (msg.hostConnected) {
        // Host is ready, send auth
        console.log('[Relay] Sending auth request to host...');
        this.sendRaw({ id: genId(), type: 'request', method: 'auth', params: { relay: true } });
      } else {
        console.log('[Relay] Host not connected — waiting for host_reconnected event');
      }
      return true;
    }
    if (msg.type === 'event' && msg.method === 'relay.host_reconnected') {
      this.sendRaw({ id: genId(), type: 'request', method: 'auth', params: { relay: true } });
      return true;
    }
    if (msg.type === 'event' && msg.method === 'relay.host_disconnected') {
      return true;
    }
    return false;
  }

  private handleMessage(raw: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('[RPC] Invalid JSON:', raw);
      return;
    }

    // Handle relay control messages
    if (this.conn.currentConfig?.mode === 'relay') {
      if (this.handleRelayMessage(msg)) return;
    }

    // Events
    if (msg.type === 'event') {
      console.log('[RPC] Event received:', msg.method, msg.params ? JSON.stringify(msg.params).substring(0, 100) : '');
      this.onEvent(msg.method!, msg.params);
      return;
    }

    // Stream chunks
    if (msg.type === 'stream') {
      const p = this.pending.get(msg.id);
      if (p) {
        const chunk = msg.result as string;
        p.streamBuffer = (p.streamBuffer || '') + chunk;
        p.onChunk?.(chunk);
      }
      this.onStreamChunk(msg.id, msg.result);
      return;
    }

    // Response / Error
    if (msg.type === 'response' || msg.type === 'error') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.type === 'error' || msg.error) {
          p.reject(new Error(msg.error?.message || 'Unknown error'));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
  }

  /**
   * Send an RPC request and wait for a response.
   */
  request<T = any>(method: string, params?: any, timeoutMs = 30000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = genId();
      this.pending.set(id, { resolve, reject });
      this.sendRaw({ id, type: 'request', method, params });

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send an RPC request that returns a stream.
   * onChunk called for each chunk; resolves with full accumulated text.
   */
  stream(method: string, params: any, onChunk: (chunk: string) => void, timeoutMs = 120000): Promise<string> {
    return new Promise((resolve, reject) => {
      const id = genId();
      const pending: PendingRequest = {
        resolve: () => {
          this.pending.delete(id);
          resolve(pending.streamBuffer || '');
        },
        reject: (err) => {
          this.pending.delete(id);
          reject(err);
        },
        onChunk,
        streamBuffer: '',
      };
      this.pending.set(id, pending);
      this.sendRaw({ id, type: 'request', method, params });

      setTimeout(() => {
        if (this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          resolve(p.streamBuffer || '');
        }
      }, timeoutMs);
    });
  }

  /**
   * Send a raw message object.
   */
  sendRaw(msg: any): void {
    this.conn.send(JSON.stringify(msg));
  }

  /**
   * Authenticate with the server.
   */
  authenticate(sessionId?: string, token?: string): void {
    if (sessionId) {
      this.sendRaw({ id: genId(), type: 'request', method: 'auth', params: { sessionId } });
    } else if (token) {
      // First try HTTP auth to get session, then WS auth
      this.sendRaw({ id: genId(), type: 'request', method: 'auth', params: { token } });
    }
  }

  /**
   * Cancel all pending requests.
   */
  cancelAll(): void {
    for (const [id, p] of this.pending) {
      p.reject(new Error('Connection closed'));
    }
    this.pending.clear();
  }
}
