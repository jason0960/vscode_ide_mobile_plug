/**
 * Pub/Sub adapter that bridges GoogleCloud Pub/Sub to the AppStore.
 *
 * This provides an alternative message transport to WebSocket.
 * When connected via Pub/Sub, the mobile app publishes prompts to
 * the topic and subscribes for extension responses.
 *
 * Usage:
 *   const adapter = new PubSubAdapter(config);
 *   adapter.connect(storeCallbacks);
 *   adapter.sendAgentPrompt("hello");
 *   adapter.dispose();
 */

import { PubSubClient, PubSubClientConfig, PubSubMessage } from './pubsub';

// ─── Types ──────────────────────────────────────────────

export interface PubSubStoreCallbacks {
  onStreamChunk: (chunk: string, correlationId?: string) => void;
  onStreamEnd: (content: string, correlationId?: string) => void;
  onEvent: (method: string, params: any) => void;
  onResponse: (result: any, correlationId: string) => void;
  onError: (error: string, correlationId?: string) => void;
  onConnectionChange: (connected: boolean) => void;
}

export interface PubSubConnectOptions {
  projectId: string;
  topicName: string;
  mobileSubscription: string;
  accessToken: string;
  userId: string;
}

// ─── Adapter ────────────────────────────────────────────

export class PubSubAdapter {
  private client: PubSubClient | null = null;
  private callbacks: PubSubStoreCallbacks | null = null;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private connected = false;

  /**
   * Connect to Pub/Sub and start listening for messages.
   */
  connect(options: PubSubConnectOptions, callbacks: PubSubStoreCallbacks): void {
    this.dispose(); // Clean up any existing connection

    const config: PubSubClientConfig = {
      projectId: options.projectId,
      topicName: options.topicName,
      mobileSubscription: options.mobileSubscription,
      accessToken: options.accessToken,
      userId: options.userId,
    };

    this.client = new PubSubClient(config);
    this.callbacks = callbacks;

    // Start listening for extension → mobile messages
    this.client.startListening((msg: PubSubMessage) => {
      this.handleMessage(msg);
    });

    this.connected = true;
    callbacks.onConnectionChange(true);

    // Health check every 30s
    this.tokenRefreshTimer = setInterval(async () => {
      if (this.client) {
        const ok = await this.client.healthCheck();
        if (!ok && this.connected) {
          this.connected = false;
          callbacks.onConnectionChange(false);
        } else if (ok && !this.connected) {
          this.connected = true;
          callbacks.onConnectionChange(true);
        }
      }
    }, 30_000);
  }

  /**
   * Update the access token (e.g., from extension after refresh).
   */
  refreshToken(token: string): void {
    this.client?.setAccessToken(token);
  }

  // ─── Send Methods ─────────────────────────────────────

  async sendPrompt(text: string, model?: string, history?: any[]): Promise<void> {
    if (!this.client) throw new Error('Pub/Sub not connected');
    await this.client.sendPrompt(text, model, history);
  }

  async sendAgentPrompt(text: string): Promise<void> {
    if (!this.client) throw new Error('Pub/Sub not connected');
    await this.client.sendAgentPrompt(text);
  }

  async sendCancel(): Promise<void> {
    if (!this.client) throw new Error('Pub/Sub not connected');
    await this.client.sendCancel();
  }

  async sendRequest(method: string, params?: any): Promise<void> {
    if (!this.client) throw new Error('Pub/Sub not connected');
    await this.client.sendRequest(method, params);
  }

  // ─── Message Handler ──────────────────────────────────

  private handleMessage(msg: PubSubMessage): void {
    if (!this.callbacks) return;

    const payload = msg.payload ? JSON.parse(msg.payload) : {};

    switch (msg.messageType) {
      case 'stream_chunk':
        this.callbacks.onStreamChunk(payload.chunk || '', msg.correlationId);
        break;

      case 'stream_end':
        this.callbacks.onStreamEnd(payload.content || '', msg.correlationId);
        break;

      case 'event':
        this.callbacks.onEvent(msg.method || '', payload);
        break;

      case 'response':
        if (msg.correlationId) {
          this.callbacks.onResponse(payload.result, msg.correlationId);
        }
        break;

      case 'error':
        this.callbacks.onError(payload.error || 'Unknown error', msg.correlationId);
        break;

      default:
        console.warn(`[PubSubAdapter] Unknown messageType: ${msg.messageType}`);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────

  get isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
    if (this.client) {
      this.client.dispose();
      this.client = null;
    }
    this.connected = false;
    this.callbacks = null;
  }
}
