/**
 * WebSocket connection manager for Mobile Copilot.
 * Supports both direct (LAN/tunnel) and cloud relay connections.
 */

export type ConnectionMode = 'direct' | 'relay';
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'authenticated';

export interface ConnectionConfig {
  mode: ConnectionMode;
  /** Direct mode: ws://host:port/ws */
  directUrl?: string;
  /** Direct mode: auth token from QR code */
  token?: string;
  /** Relay mode: relay server base URL */
  relayUrl?: string;
  /** Relay mode: room code */
  relayCode?: string;
}

type MessageHandler = (data: string) => void;
type StatusHandler = (status: ConnectionStatus) => void;
type ErrorHandler = (error: string) => void;

export class ConnectionManager {
  private ws: WebSocket | null = null;
  private config: ConnectionConfig | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _status: ConnectionStatus = 'disconnected';

  public onMessage: MessageHandler = () => {};
  public onStatusChange: StatusHandler = () => {};
  public onError: ErrorHandler = () => {};

  get status(): ConnectionStatus {
    return this._status;
  }

  get isConnected(): boolean {
    return this._status === 'connected' || this._status === 'authenticated';
  }

  get currentConfig(): ConnectionConfig | null {
    return this.config;
  }

  /**
   * Connect in direct mode (LAN/tunnel).
   */
  connectDirect(url: string, token: string): void {
    this.config = { mode: 'direct', directUrl: url, token };
    this.connect();
  }

  /**
   * Connect via cloud relay with room code.
   */
  connectRelay(relayUrl: string, roomCode: string): void {
    // Normalize URL
    let wsBase = relayUrl.replace(/\/$/, '');
    if (wsBase.startsWith('http://')) wsBase = 'ws://' + wsBase.slice(7);
    else if (wsBase.startsWith('https://')) wsBase = 'wss://' + wsBase.slice(8);
    else if (!wsBase.startsWith('ws://') && !wsBase.startsWith('wss://')) wsBase = 'wss://' + wsBase;

    const wsUrl = `${wsBase}/relay/join?code=${encodeURIComponent(roomCode.toUpperCase())}`;

    this.config = { mode: 'relay', relayUrl, relayCode: roomCode };
    this.connectToUrl(wsUrl);
  }

  /**
   * Disconnect and stop auto-reconnect.
   */
  disconnect(): void {
    this.clearTimers();
    this.config = null;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.setStatus('disconnected');
  }

  /**
   * Send a raw string message.
   */
  send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ─── Internal ────────────────────────────────────────

  private connect(): void {
    if (!this.config) return;

    if (this.config.mode === 'direct') {
      const url = this.config.directUrl!;
      // Convert http(s) to ws(s)
      let wsUrl = url;
      if (wsUrl.startsWith('http://')) wsUrl = 'ws://' + wsUrl.slice(7);
      else if (wsUrl.startsWith('https://')) wsUrl = 'wss://' + wsUrl.slice(8);
      if (!wsUrl.endsWith('/ws')) wsUrl = wsUrl.replace(/\/?$/, '/ws');
      this.connectToUrl(wsUrl);
    }
  }

  private connectToUrl(url: string): void {
    this.clearTimers();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
    }

    this.setStatus('connecting');
    console.log('[WS] Connecting to', url);

    try {
      this.ws = new WebSocket(url);
    } catch (err: any) {
      this.onError(`Connection failed: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.setStatus('connected');
      this.startHeartbeat();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.onMessage(typeof event.data === 'string' ? event.data : String(event.data));
    };

    this.ws.onclose = (event: CloseEvent) => {
      console.log('[WS] Closed:', event.code, event.reason);
      this.stopHeartbeat();

      // Fatal close codes — don't reconnect
      if (event.code === 4003) {
        this.setStatus('disconnected');
        this.onError('Authentication failed. Reconnect with new credentials.');
        return;
      }
      if (event.code === 4004) {
        this.setStatus('disconnected');
        this.onError('Room not found. Check the room code.');
        return;
      }
      if (event.code === 4008) {
        this.setStatus('disconnected');
        this.onError('Room expired. Get a new room code.');
        return;
      }

      // Auto-reconnect for transient failures
      if (this.config) {
        this.setStatus('connecting');
        this.scheduleReconnect();
      } else {
        this.setStatus('disconnected');
      }
    };

    this.ws.onerror = () => {
      console.log('[WS] Error');
    };
  }

  private setStatus(status: ConnectionStatus): void {
    if (this._status !== status) {
      this._status = status;
      this.onStatusChange(status);
    }
  }

  /** Mark as fully authenticated (called by RPC layer after auth handshake). */
  markAuthenticated(): void {
    this.setStatus('authenticated');
  }

  private scheduleReconnect(): void {
    this.clearTimers();
    this.reconnectTimer = setTimeout(() => {
      if (!this.config) return;
      if (this.config.mode === 'relay' && this.config.relayUrl && this.config.relayCode) {
        this.connectRelay(this.config.relayUrl, this.config.relayCode);
      } else {
        this.connect();
      }
    }, 3000);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        // Send a ping frame equivalent — server will ignore unknown types
        try {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          // Ignore
        }
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
  }
}
