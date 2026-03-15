/**
 * Google Cloud Pub/Sub transport for Mobile Copilot.
 *
 * Replaces WebSocket relay with Pub/Sub for reliable message delivery.
 * Extension publishes responses and subscribes to incoming prompts.
 */

import * as vscode from 'vscode';

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

export interface PubSubConfig {
  projectId: string;
  topicName: string;
  /** Subscription for messages FROM mobile (direction=mobile_to_ext) */
  extensionSubscription: string;
}

type MessageCallback = (msg: PubSubMessage) => void;

// ─── Pub/Sub Transport ──────────────────────────────────

export class PubSubTransport {
  private projectId: string;
  private topicPath: string;
  private subscriptionPath: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;
  private keyFileData: any = null;
  private logger: vscode.LogOutputChannel;
  private onMessage: MessageCallback = () => {};
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private disposed = false;
  private userId: string;

  private static readonly BASE_URL = 'https://pubsub.googleapis.com/v1';
  private static readonly POLL_INTERVAL_MS = 2_000;
  private static readonly MAX_MESSAGES_PER_PULL = 10;

  constructor(config: PubSubConfig, userId: string, logger: vscode.LogOutputChannel) {
    this.projectId = config.projectId;
    this.topicPath = `projects/${config.projectId}/topics/${config.topicName}`;
    this.subscriptionPath = `projects/${config.projectId}/subscriptions/${config.extensionSubscription}`;
    this.userId = userId;
    this.logger = logger;
  }

  // ─── Auth ──────────────────────────────────────────────

  /**
   * Get an access token using service account JWT or Application Default Credentials.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    if (this.keyFileData) {
      this.accessToken = await this.getTokenFromServiceAccount();
    } else {
      this.accessToken = await this.getTokenFromADC();
    }

    this.tokenExpiry = Date.now() + 3600_000; // 1 hour
    return this.accessToken;
  }

  /**
   * Create a self-signed JWT for service account auth.
   * Google Pub/Sub accepts self-signed JWTs directly — no token exchange needed.
   */
  private async getTokenFromServiceAccount(): Promise<string> {
    const crypto = require('crypto');
    const sa = this.keyFileData;

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
    const payload = {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://pubsub.googleapis.com/',
      iat: now,
      exp: now + 3600,
    };

    const b64 = (obj: any) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const unsigned = `${b64(header)}.${b64(payload)}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(sa.private_key, 'base64url');

    const jwt = `${unsigned}.${signature}`;
    this.logger.info('[PubSub] Generated service account JWT');
    return jwt;
  }

  /**
   * Get token from Application Default Credentials (gcloud CLI).
   */
  private async getTokenFromADC(): Promise<string> {
    const { execFileSync } = require('child_process');
    // Try 'gcloud' on PATH first, then common install locations
    const gcloudPaths = [
      'gcloud',
      '/tmp/google-cloud-sdk/bin/gcloud',
      '/usr/local/bin/gcloud',
      '/usr/bin/gcloud',
      `${process.env.HOME}/google-cloud-sdk/bin/gcloud`,
    ];
    for (const gcloudBin of gcloudPaths) {
      try {
        const token = execFileSync(gcloudBin, ['auth', 'print-access-token'], {
          encoding: 'utf-8',
          timeout: 10_000,
        }).trim();
        this.logger.info(`[PubSub] Got token from gcloud CLI (${gcloudBin})`);
        return token;
      } catch {
        // Try next path
      }
    }
    this.logger.error('[PubSub] Failed to get token from gcloud CLI — tried all known paths');
    throw new Error(
      'No Pub/Sub credentials. Install gcloud CLI and run "gcloud auth login".',
    );
  }

  // ─── HTTP Helpers ──────────────────────────────────────

  private async pubsubFetch(url: string, body?: any): Promise<any> {
    const token = await this.getAccessToken();
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Pub/Sub API error ${resp.status}: ${text}`);
    }

    return resp.json();
  }

  // ─── Publish ──────────────────────────────────────────

  /**
   * Publish a message to the topic (extension → mobile).
   */
  async publish(msg: Omit<PubSubMessage, 'id' | 'userId' | 'direction' | 'timestamp'>): Promise<void> {
    const fullMsg: PubSubMessage = {
      id: require('crypto').randomUUID(),
      userId: this.userId,
      direction: 'ext_to_mobile',
      timestamp: Date.now(),
      ...msg,
    };

    const data = Buffer.from(JSON.stringify(fullMsg)).toString('base64');

    try {
      await this.pubsubFetch(`${PubSubTransport.BASE_URL}/${this.topicPath}:publish`, {
        messages: [
          {
            data,
            attributes: {
              direction: 'ext_to_mobile',
              userId: this.userId,
              messageType: fullMsg.messageType,
            },
            orderingKey: this.userId,
          },
        ],
      });
      this.logger.info(`[PubSub] Published ${fullMsg.messageType} (${data.length} bytes)`);
    } catch (err: any) {
      this.logger.error(`[PubSub] Publish failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Convenience: publish a stream chunk.
   */
  async publishChunk(chunk: string, correlationId?: string): Promise<void> {
    await this.publish({
      messageType: 'stream_chunk',
      correlationId,
      payload: JSON.stringify({ chunk }),
    });
  }

  /**
   * Convenience: publish stream end.
   */
  async publishStreamEnd(content: string, correlationId?: string): Promise<void> {
    await this.publish({
      messageType: 'stream_end',
      correlationId,
      payload: JSON.stringify({ content }),
    });
  }

  /**
   * Convenience: publish an event (e.g., agent.status).
   */
  async publishEvent(method: string, data: any): Promise<void> {
    await this.publish({
      messageType: 'event',
      method,
      payload: JSON.stringify(data),
    });
  }

  /**
   * Convenience: publish a response to an RPC request.
   */
  async publishResponse(result: any, correlationId: string): Promise<void> {
    await this.publish({
      messageType: 'response',
      correlationId,
      payload: JSON.stringify({ result }),
    });
  }

  /**
   * Convenience: publish an error.
   */
  async publishError(error: string, correlationId?: string, errorCode?: number): Promise<void> {
    await this.publish({
      messageType: 'error',
      correlationId,
      payload: JSON.stringify({ error, errorCode }),
    });
  }

  // ─── Subscribe (Pull) ─────────────────────────────────

  /**
   * Start polling the subscription for incoming messages.
   */
  startListening(callback: MessageCallback): void {
    this.onMessage = callback;
    this.disposed = false;

    this.logger.info(`[PubSub] Starting pull subscription: ${this.subscriptionPath}`);
    this.logger.info(`[PubSub] Polling every ${PubSubTransport.POLL_INTERVAL_MS}ms`);

    // Immediate first pull
    this.pull();

    // Then poll on interval
    this.pollTimer = setInterval(() => {
      if (!this.isPolling) {
        this.pull();
      }
    }, PubSubTransport.POLL_INTERVAL_MS);
  }

  /**
   * Pull messages from the subscription and process them.
   */
  private async pull(): Promise<void> {
    if (this.disposed || this.isPolling) return;
    this.isPolling = true;

    try {
      const result = await this.pubsubFetch(
        `${PubSubTransport.BASE_URL}/${this.subscriptionPath}:pull`,
        { maxMessages: PubSubTransport.MAX_MESSAGES_PER_PULL },
      );

      const messages = result.receivedMessages || [];
      if (messages.length === 0) {
        this.isPolling = false;
        return;
      }

      this.logger.info(`[PubSub] Pulled ${messages.length} message(s)`);
      const ackIds: string[] = [];

      for (const received of messages) {
        try {
          const data = Buffer.from(received.message.data, 'base64').toString('utf-8');
          const msg: PubSubMessage = JSON.parse(data);

          // Only process messages for this user
          if (msg.userId === this.userId && msg.direction === 'mobile_to_ext') {
            this.logger.info(`[PubSub] Received ${msg.messageType} from mobile`);
            this.onMessage(msg);
          }

          ackIds.push(received.ackId);
        } catch (err: any) {
          this.logger.error(`[PubSub] Failed to parse message: ${err.message}`);
          ackIds.push(received.ackId); // Ack bad messages too to avoid redelivery
        }
      }

      // Acknowledge all processed messages
      if (ackIds.length > 0) {
        await this.pubsubFetch(
          `${PubSubTransport.BASE_URL}/${this.subscriptionPath}:acknowledge`,
          { ackIds },
        );
        this.logger.info(`[PubSub] Acknowledged ${ackIds.length} message(s)`);
      }
    } catch (err: any) {
      this.logger.error(`[PubSub] Pull error: ${err.message}`);
    }

    this.isPolling = false;
  }

  // ─── Lifecycle ─────────────────────────────────────────

  /**
   * Stop listening and clean up.
   */
  dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.logger.info('[PubSub] Disposed');
  }

  /**
   * Check if the transport can connect (credentials are valid).
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getAccessToken();
      // Try a pull with 0 messages to test connectivity
      await this.pubsubFetch(
        `${PubSubTransport.BASE_URL}/${this.subscriptionPath}:pull`,
        { maxMessages: 1 },
      );
      return true;
    } catch (err: any) {
      this.logger.error(`[PubSub] Health check failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Get the topic path for sharing with mobile clients.
   */
  getTopicInfo(): { projectId: string; topicPath: string; userId: string } {
    return {
      projectId: this.projectId,
      topicPath: this.topicPath,
      userId: this.userId,
    };
  }

  /**
   * Generate a short-lived token for the mobile client to use.
   * Mobile uses this to publish/pull via REST API.
   */
  async generateMobileToken(): Promise<string> {
    return this.getAccessToken();
  }
}
