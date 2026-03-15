/**
 * Google Cloud Pub/Sub REST client for Mobile Copilot.
 *
 * Uses fetch-based REST API (no native Node.js deps) so it works
 * in both React Native and browser environments.
 */

// ─── Types ──────────────────────────────────────────────

export interface PubSubMessage {
  id: string;
  correlationId?: string;
  userId: string;
  direction: 'mobile_to_ext' | 'ext_to_mobile';
  messageType:
    | 'prompt'
    | 'agent_prompt'
    | 'cancel'
    | 'auth'
    | 'request'
    | 'stream_chunk'
    | 'stream_end'
    | 'event'
    | 'response'
    | 'error';
  method?: string;
  payload?: string; // JSON-encoded
  timestamp: number;
}

export interface PubSubClientConfig {
  projectId: string;
  topicName: string;
  /** Subscription for messages FROM extension (direction=ext_to_mobile) */
  mobileSubscription: string;
  /** Access token (provided by extension during auth handshake) */
  accessToken: string;
  /** User ID (provided by extension during auth handshake) */
  userId: string;
}

type MessageCallback = (msg: PubSubMessage) => void;

// ─── Helpers ────────────────────────────────────────────

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function toBase64(str: string): string {
  // Works in both browser and React Native
  if (typeof btoa === 'function') {
    return btoa(unescape(encodeURIComponent(str)));
  }
  return Buffer.from(str, 'utf-8').toString('base64');
}

function fromBase64(str: string): string {
  if (typeof atob === 'function') {
    return decodeURIComponent(escape(atob(str)));
  }
  return Buffer.from(str, 'base64').toString('utf-8');
}

// ─── Pub/Sub REST Client ────────────────────────────────

export class PubSubClient {
  private config: PubSubClientConfig;
  private topicPath: string;
  private subscriptionPath: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private disposed = false;
  private onMessage: MessageCallback = () => {};

  private static readonly BASE_URL = 'https://pubsub.googleapis.com/v1';
  private static readonly POLL_INTERVAL_MS = 2_000;
  private static readonly MAX_MESSAGES_PER_PULL = 10;

  constructor(config: PubSubClientConfig) {
    this.config = config;
    this.topicPath = `projects/${config.projectId}/topics/${config.topicName}`;
    this.subscriptionPath = `projects/${config.projectId}/subscriptions/${config.mobileSubscription}`;
  }

  /**
   * Update the access token (e.g., after refresh).
   */
  setAccessToken(token: string): void {
    this.config.accessToken = token;
  }

  // ─── HTTP Helpers ──────────────────────────────────────

  private async pubsubFetch(url: string, body?: any): Promise<any> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();

      // Token expired
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`AUTH_EXPIRED: ${text}`);
      }

      throw new Error(`Pub/Sub API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  // ─── Publish (Mobile → Extension) ─────────────────────

  /**
   * Publish a message to the topic.
   */
  async publish(msg: Omit<PubSubMessage, 'id' | 'userId' | 'direction' | 'timestamp'>): Promise<void> {
    const fullMsg: PubSubMessage = {
      id: generateId(),
      userId: this.config.userId,
      direction: 'mobile_to_ext',
      timestamp: Date.now(),
      ...msg,
    };

    const data = toBase64(JSON.stringify(fullMsg));

    await this.pubsubFetch(`${PubSubClient.BASE_URL}/${this.topicPath}:publish`, {
      messages: [
        {
          data,
          attributes: {
            direction: 'mobile_to_ext',
            userId: this.config.userId,
            messageType: fullMsg.messageType,
          },
          orderingKey: this.config.userId,
        },
      ],
    });
  }

  /**
   * Send a chat prompt.
   */
  async sendPrompt(text: string, model?: string, history?: any[]): Promise<void> {
    await this.publish({
      messageType: 'prompt',
      payload: JSON.stringify({ text, model, history }),
    });
  }

  /**
   * Send an agent prompt.
   */
  async sendAgentPrompt(text: string): Promise<void> {
    await this.publish({
      messageType: 'agent_prompt',
      payload: JSON.stringify({ text }),
    });
  }

  /**
   * Send a cancel signal.
   */
  async sendCancel(): Promise<void> {
    await this.publish({ messageType: 'cancel' });
  }

  /**
   * Send an RPC request.
   */
  async sendRequest(method: string, params?: any): Promise<void> {
    await this.publish({
      messageType: 'request',
      method,
      payload: params ? JSON.stringify(params) : undefined,
    });
  }

  // ─── Subscribe (Pull — Extension → Mobile) ────────────

  /**
   * Start polling for messages from the extension.
   */
  startListening(callback: MessageCallback): void {
    this.onMessage = callback;
    this.disposed = false;

    // Immediate first pull
    this.pull();

    // Then poll on interval
    this.pollTimer = setInterval(() => {
      if (!this.isPolling) {
        this.pull();
      }
    }, PubSubClient.POLL_INTERVAL_MS);
  }

  /**
   * Pull messages from the subscription.
   */
  private async pull(): Promise<void> {
    if (this.disposed || this.isPolling) return;
    this.isPolling = true;

    try {
      const result = await this.pubsubFetch(
        `${PubSubClient.BASE_URL}/${this.subscriptionPath}:pull`,
        { maxMessages: PubSubClient.MAX_MESSAGES_PER_PULL },
      );

      const messages = result.receivedMessages || [];
      if (messages.length === 0) {
        this.isPolling = false;
        return;
      }

      const ackIds: string[] = [];

      for (const received of messages) {
        try {
          const data = fromBase64(received.message.data);
          const msg: PubSubMessage = JSON.parse(data);

          // Only process messages for this user coming from extension
          if (msg.userId === this.config.userId && msg.direction === 'ext_to_mobile') {
            this.onMessage(msg);
          }

          ackIds.push(received.ackId);
        } catch {
          ackIds.push(received.ackId); // Ack bad messages
        }
      }

      // Acknowledge
      if (ackIds.length > 0) {
        await this.pubsubFetch(
          `${PubSubClient.BASE_URL}/${this.subscriptionPath}:acknowledge`,
          { ackIds },
        );
      }
    } catch (err: any) {
      // Don't spam errors — log quietly
      console.warn('[PubSub] Pull error:', err.message);
    }

    this.isPolling = false;
  }

  // ─── Lifecycle ─────────────────────────────────────────

  /**
   * Stop polling and clean up.
   */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Check if the connection is working.
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.pubsubFetch(
        `${PubSubClient.BASE_URL}/${this.subscriptionPath}:pull`,
        { maxMessages: 1 },
      );
      return true;
    } catch {
      return false;
    }
  }
}
