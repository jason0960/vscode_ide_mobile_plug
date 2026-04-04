/**
 * Google Cloud Pub/Sub transport for Mobile Copilot (extension side).
 *
 * Drop-in replacement for RelayClient — exposes the same event interface
 * (`onMessage`, `onRoomCreated`, `onDisconnected`, `onClientJoined`,
 * `onClientLeft`) so `server.ts` can consume it without changes.
 *
 * ## Architecture
 *
 * ```
 * Mobile App ──publish──▶ Topic ──ext-{userId} sub──▶ PubSubTransport.pull()
 * PubSubTransport.send() ──publish──▶ Topic ──mobile-{userId} sub──▶ Mobile App
 * ```
 *
 * ## Authentication
 *
 * Supports two credential sources (in priority order):
 * 1. Service account JSON key file (for CI / headless environments)
 * 2. Application Default Credentials via `gcloud auth print-access-token`
 *
 * ## Message Format
 *
 * All messages use `PubSubEnvelope` from `@mobile-copilot/protocol`.
 * RPC messages are JSON-encoded inside the envelope's `payload` field.
 *
 * @module PubSubTransport
 */

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import type { ILogger } from '@mobile-copilot/adapter-core';
import type {
  PubSubEnvelope,
  PubSubConfig,
  PubSubPairingInfo,
} from '@mobile-copilot/protocol';
import {
  PUBSUB_API_BASE_URL,
  PUBSUB_POLL_INTERVAL_MS,
  PUBSUB_MAX_MESSAGES_PER_PULL,
  PUBSUB_HEALTH_CHECK_INTERVAL_MS,
} from '@mobile-copilot/protocol';

// ─── HTTP Client (injectable for testing) ───────────────

/**
 * Minimal HTTP interface for Pub/Sub REST calls.
 * Injectable for deterministic testing without network I/O.
 */
export interface PubSubHttpClient {
  post(url: string, body: unknown, token: string): Promise<PubSubHttpResponse>;
}

export interface PubSubHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}

/**
 * Default HTTP client using the global `fetch` API.
 */
export class FetchHttpClient implements PubSubHttpClient {
  async post(url: string, body: unknown, token: string): Promise<PubSubHttpResponse> {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return resp;
  }
}

// ─── Avro JSON Encoding Helpers ──────────────────────────

/**
 * Wrap a PubSubEnvelope for Avro JSON encoding.
 *
 * The GoPilotSchemaV2 Avro schema declares `correlationId` and `payload` as
 * union types `["null", "string"]`.  Avro JSON encoding represents these as
 * either `null` or `{"string": "value"}`.  This function converts from the
 * TypeScript-natural shape (plain strings / undefined) to the Avro shape
 * so that Pub/Sub schema validation passes.
 */
export function toAvroJson(envelope: PubSubEnvelope): Record<string, unknown> {
  return {
    id: envelope.id,
    correlationId: envelope.correlationId
      ? { string: envelope.correlationId }
      : null,
    userId: envelope.userId,
    direction: envelope.direction,
    messageType: envelope.messageType,
    payload: envelope.payload
      ? { string: envelope.payload }
      : null,
    timestamp: envelope.timestamp,
  };
}

/**
 * Unwrap a JSON-parsed Avro record back into a normal PubSubEnvelope.
 *
 * Handles both Avro union shapes (`{"string":"val"}` / `null`) *and*
 * the plain-string shape so that old messages still decode correctly.
 */
export function fromAvroJson(raw: Record<string, unknown>): PubSubEnvelope {
  const unwrap = (v: unknown): string | undefined => {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v !== null && 'string' in v) {
      return (v as { string: string }).string;
    }
    return undefined;
  };

  return {
    id: raw.id as string,
    correlationId: unwrap(raw.correlationId),
    userId: raw.userId as string,
    direction: raw.direction as PubSubEnvelope['direction'],
    messageType: raw.messageType as PubSubEnvelope['messageType'],
    payload: unwrap(raw.payload) ?? '',
    timestamp: raw.timestamp as number,
  };
}

// ─── Token Provider (injectable for testing) ─────────────

/**
 * Provides access tokens for Pub/Sub API authentication.
 * Injectable for testing without real credentials.
 */
export interface TokenProvider {
  getToken(): Promise<string>;
}

/**
 * Gets tokens from `gcloud auth print-access-token` (ADC).
 */
export class AdcTokenProvider implements TokenProvider {
  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.cachedToken;
    }

    const { execFileSync } = require('child_process');
    const gcloudPaths = [
      'gcloud',
      '/usr/local/bin/gcloud',
      '/usr/bin/gcloud',
      `${process.env.HOME}/google-cloud-sdk/bin/gcloud`,
    ];

    for (const bin of gcloudPaths) {
      try {
        const token = execFileSync(bin, ['auth', 'print-access-token'], {
          encoding: 'utf-8',
          timeout: 10_000,
        }).trim();
        this.cachedToken = token;
        this.tokenExpiry = Date.now() + 3_600_000;
        return token;
      } catch {
        continue;
      }
    }

    throw new Error(
      'No Pub/Sub credentials found. Run `gcloud auth application-default login`.',
    );
  }
}

/**
 * Uses a service account key file for JWT-based auth.
 */
export class ServiceAccountTokenProvider implements TokenProvider {
  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  constructor(private readonly keyFileData: {
    private_key_id: string;
    private_key: string;
    client_email: string;
  }) {}

  async getToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.cachedToken;
    }

    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', typ: 'JWT', kid: this.keyFileData.private_key_id };
    const payload = {
      iss: this.keyFileData.client_email,
      sub: this.keyFileData.client_email,
      aud: 'https://pubsub.googleapis.com/',
      iat: now,
      exp: now + 3600,
    };

    const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const unsigned = `${b64(header)}.${b64(payload)}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(unsigned);
    const signature = sign.sign(this.keyFileData.private_key, 'base64url');

    this.cachedToken = `${unsigned}.${signature}`;
    this.tokenExpiry = Date.now() + 3_600_000;
    return this.cachedToken;
  }
}

// ─── PubSubTransport Options ─────────────────────────────

export interface PubSubTransportOptions {
  /** Pub/Sub configuration (project, topic, subscription). */
  config: PubSubConfig;

  /** Subscription name for the mobile app to pull from (ext → mobile messages). */
  mobileSubscriptionName?: string;

  /** Unique user/session ID for message routing. */
  userId: string;

  /** Logger instance. */
  logger: ILogger;

  /** HTTP client (defaults to FetchHttpClient). */
  httpClient?: PubSubHttpClient;

  /** Token provider (defaults to AdcTokenProvider). */
  tokenProvider?: TokenProvider;

  /** Poll interval in ms (defaults to PUBSUB_POLL_INTERVAL_MS). */
  pollIntervalMs?: number;

  /** Max messages per pull (defaults to PUBSUB_MAX_MESSAGES_PER_PULL). */
  maxMessagesPerPull?: number;

  /** URL of the relay server for pairing code exchange (e.g. https://gopilot-relay.onrender.com). */
  pairingRelayUrl?: string;

  /** Token refresh interval in ms (defaults to 45 minutes). */
  tokenRefreshIntervalMs?: number;
}

// ─── PubSubTransport ─────────────────────────────────────

/**
 * Pub/Sub transport that implements the same event interface as `RelayClient`.
 *
 * ## Drop-in Compatibility
 *
 * This class exposes the same public API as `RelayClient`:
 * - `connect()` → starts polling, fires `onRoomCreated`
 * - `send(data)` → publishes an RPC message envelope
 * - `disconnect()` → stops polling, fires `onDisconnected`
 * - `isConnected` / `code` getters
 * - `onMessage`, `onRoomCreated`, `onDisconnected`, `onClientJoined`, `onClientLeft` events
 *
 * `server.ts` can switch between `RelayClient` and `PubSubTransport`
 * by changing a single constructor call.
 */
export class PubSubTransport {
  // ─── Event emitters (same shape as RelayClient) ────────

  /** Fires when connected and ready. Payload includes a synthetic pairing code. */
  readonly onRoomCreated = new vscode.EventEmitter<{ code: string }>();

  /** Fires when transport disconnects (poll stopped or health check failed). */
  readonly onDisconnected = new vscode.EventEmitter<void>();

  /** Fires when an RPC message arrives from mobile. Payload is raw JSON string. */
  readonly onMessage = new vscode.EventEmitter<string>();

  /** Fires when a mobile client connects (pairing message received). */
  readonly onClientJoined = new vscode.EventEmitter<{ clientCount: number }>();

  /** Fires when a mobile client disconnects. */
  readonly onClientLeft = new vscode.EventEmitter<{ clientCount: number }>();

  // ─── Internal state ────────────────────────────────────

  private readonly config: PubSubConfig;
  private readonly mobileSubscriptionName: string;
  private readonly userId: string;
  private readonly logger: ILogger;
  private readonly http: PubSubHttpClient;
  private readonly tokenProvider: TokenProvider;
  private readonly pollIntervalMs: number;
  private readonly maxMessagesPerPull: number;
  private readonly pairingRelayUrl: string | null;
  private readonly tokenRefreshIntervalMs: number;

  /** Default token refresh interval: 45 minutes (tokens expire after 60 min). */
  private static readonly DEFAULT_TOKEN_REFRESH_MS = 45 * 60 * 1000;

  private readonly topicPath: string;
  private readonly subscriptionPath: string;

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private tokenRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private disposed = false;
  private connected = false;
  private clientCount = 0;
  private pairingCode: string | null = null;

  /** Set of message IDs already processed — prevents redelivery duplicates. */
  private readonly processedIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = 1000;

  /** Max consecutive poll failures before disconnecting. */
  private static readonly MAX_POLL_RETRIES = 3;

  /** Consecutive poll failure count. */
  private pollFailures = 0;

  constructor(options: PubSubTransportOptions) {
    this.config = options.config;
    this.mobileSubscriptionName = options.mobileSubscriptionName || `mobile-${options.userId}`;
    this.userId = options.userId;
    this.logger = options.logger;
    this.http = options.httpClient ?? new FetchHttpClient();
    this.tokenProvider = options.tokenProvider ?? new AdcTokenProvider();
    this.pollIntervalMs = options.pollIntervalMs ?? PUBSUB_POLL_INTERVAL_MS;
    this.maxMessagesPerPull = options.maxMessagesPerPull ?? PUBSUB_MAX_MESSAGES_PER_PULL;
    this.pairingRelayUrl = options.pairingRelayUrl ?? null;
    this.tokenRefreshIntervalMs = options.tokenRefreshIntervalMs ?? PubSubTransport.DEFAULT_TOKEN_REFRESH_MS;

    this.topicPath = `projects/${this.config.projectId}/topics/${this.config.topicName}`;
    this.subscriptionPath = `projects/${this.config.projectId}/subscriptions/${this.config.subscriptionName}`;
  }

  // ─── Public API (RelayClient-compatible) ───────────────

  /** Whether the transport is actively connected and polling. */
  get isConnected(): boolean {
    return this.connected && !this.disposed;
  }

  /** The pairing code (analogous to relay room code). */
  get code(): string | null {
    return this.pairingCode;
  }

  /**
   * Connect to Pub/Sub: validate credentials, register pairing code with relay, start polling.
   * Returns a pairing code that mobile clients use to connect.
   *
   * @returns The pairing code (from relay exchange if configured, else derived from userId).
   * @throws If credentials are invalid or Pub/Sub API is unreachable.
   */
  async connect(): Promise<string> {
    if (this.connected && this.pairingCode) {
      return this.pairingCode;
    }

    this.disposed = false;

    // Validate credentials with a test pull
    this.logger.info('[PubSub] Validating credentials...');
    const token = await this.tokenProvider.getToken();
    const testResp = await this.http.post(
      `${PUBSUB_API_BASE_URL}/${this.subscriptionPath}:pull`,
      { maxMessages: 1 },
      token,
    );

    if (!testResp.ok) {
      const errText = await testResp.text();
      throw new Error(`Pub/Sub credential validation failed (${testResp.status}): ${errText}`);
    }

    // Register pairing code with the relay server (if configured)
    if (this.pairingRelayUrl) {
      this.pairingCode = await this.registerPairingCode();
    } else {
      // Fallback: generate deterministic code from userId
      this.pairingCode = this.userId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase()
        || crypto.randomBytes(3).toString('hex').toUpperCase();
    }

    this.connected = true;

    // Start polling for incoming messages
    this.startPolling();

    // Start health checks
    this.startHealthChecks();

    // Start token refresh timer
    this.startTokenRefresh();

    this.logger.info(`[PubSub] Connected. Pairing code: ${this.pairingCode}`);
    this.onRoomCreated.fire({ code: this.pairingCode });

    return this.pairingCode;
  }

  /**
   * Send a raw RPC message string to the mobile client.
   * Wraps the message in a PubSubEnvelope and publishes to the topic.
   *
   * @param data - JSON string of an RpcMessage.
   */
  async send(data: string): Promise<void> {
    if (!this.connected || this.disposed) {
      this.logger.info('[PubSub] Cannot send — not connected');
      return;
    }

    const envelope: PubSubEnvelope = {
      id: crypto.randomUUID(),
      userId: this.userId,
      direction: 'ext_to_mobile',
      messageType: 'rpc',
      payload: data,
      timestamp: Date.now(),
    };

    const base64Data = Buffer.from(JSON.stringify(toAvroJson(envelope))).toString('base64');

    try {
      const token = await this.tokenProvider.getToken();
      const resp = await this.http.post(
        `${PUBSUB_API_BASE_URL}/${this.topicPath}:publish`,
        {
          messages: [{
            data: base64Data,
            attributes: {
              direction: 'ext_to_mobile',
              userId: this.userId,
              messageType: 'rpc',
            },
            orderingKey: this.userId,
          }],
        },
        token,
      );

      if (!resp.ok) {
        const errText = await resp.text();
        this.logger.error(`[PubSub] Publish failed (${resp.status}): ${errText}`);
      } else {
        this.logger.info(`[PubSub] Published (${data.length} bytes payload)`);
      }
    } catch (err: any) {
      this.logger.error(`[PubSub] Publish error: ${err.message}`);
    }
  }

  /**
   * Disconnect from Pub/Sub: stop polling, clean up timers.
   */
  disconnect(): void {
    this.stopPolling();
    this.stopHealthChecks();
    this.stopTokenRefresh();
    this.connected = false;
    this.pairingCode = null;
    this.clientCount = 0;
    this.processedIds.clear();
    this.pollFailures = 0;
    this.onDisconnected.fire();
    this.logger.info('[PubSub] Disconnected');
  }

  /**
   * Dispose all resources. Called on extension deactivation.
   */
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    this.onRoomCreated.dispose();
    this.onDisconnected.dispose();
    this.onMessage.dispose();
    this.onClientJoined.dispose();
    this.onClientLeft.dispose();
  }

  /**
   * Generate pairing info for the mobile client.
   * This is what gets encoded in a QR code or shared as a config blob.
   */
  async getPairingInfo(): Promise<PubSubPairingInfo> {
    const token = await this.tokenProvider.getToken();
    return {
      projectId: this.config.projectId,
      topicName: this.config.topicName,
      mobileSubscription: this.mobileSubscriptionName,
      extensionSubscription: this.config.subscriptionName,
      userId: this.userId,
      accessToken: token,
      tokenExpiry: Date.now() + 3_600_000,
    };
  }

  // ─── Pairing Code Exchange ─────────────────────────────

  /**
   * Register Pub/Sub pairing info with the relay server.
   * POSTs the full PubSubPairingInfo blob to `/pair`, gets back a short code.
   * Mobile can then `GET /pair/:code` to fetch the pairing info.
   */
  private async registerPairingCode(): Promise<string> {
    const pairingInfo = await this.getPairingInfo();
    const url = `${this.pairingRelayUrl}/pair`;

    this.logger.info(`[PubSub] Registering pairing code with relay: ${url}`);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pairingInfo),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Pairing registration failed (${resp.status}): ${errText}`);
    }

    const { code } = await resp.json() as { code: string };
    this.logger.info(`[PubSub] Pairing code registered: ${code}`);
    return code;
  }

  // ─── Token Refresh ─────────────────────────────────────

  /**
   * Start a periodic timer that refreshes the access token and pushes
   * the new token to the mobile client via a `token_refresh` Pub/Sub message.
   * Runs every 45 minutes (tokens expire after ~60 min).
   */
  private startTokenRefresh(): void {
    this.tokenRefreshTimer = setInterval(async () => {
      try {
        await this.refreshAndPushToken();
      } catch (err: any) {
        this.logger.error(`[PubSub] Token refresh failed: ${err.message}`);
      }
    }, this.tokenRefreshIntervalMs);
  }

  private stopTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearInterval(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }
  }

  /**
   * Fetch a fresh token, then publish a `token_refresh` message so the
   * mobile client can update its stored access token without reconnecting.
   */
  async refreshAndPushToken(): Promise<void> {
    this.logger.info('[PubSub] Refreshing access token...');

    // Force a new token fetch (invalidate cache by requesting a fresh one)
    const freshToken = await this.tokenProvider.getToken();
    const tokenExpiry = Date.now() + 3_600_000;

    // Publish token refresh as a special message type
    const envelope: PubSubEnvelope = {
      id: crypto.randomUUID(),
      userId: this.userId,
      direction: 'ext_to_mobile',
      messageType: 'token_refresh',
      payload: JSON.stringify({
        accessToken: freshToken,
        tokenExpiry,
      }),
      timestamp: Date.now(),
    };

    const base64Data = Buffer.from(JSON.stringify(toAvroJson(envelope))).toString('base64');

    const token = freshToken;
    const resp = await this.http.post(
      `${PUBSUB_API_BASE_URL}/${this.topicPath}:publish`,
      {
        messages: [{
          data: base64Data,
          attributes: {
            direction: 'ext_to_mobile',
            userId: this.userId,
            messageType: 'token_refresh',
          },
          orderingKey: this.userId,
        }],
      },
      token,
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Token refresh publish failed (${resp.status}): ${errText}`);
    }

    this.logger.info(`[PubSub] Token refresh published. Expires at ${new Date(tokenExpiry).toISOString()}`);

    // Also re-register with the relay so new mobile clients get the fresh token
    if (this.pairingRelayUrl) {
      try {
        const newCode = await this.registerPairingCode();
        if (newCode !== this.pairingCode) {
          this.pairingCode = newCode;
          this.onRoomCreated.fire({ code: newCode });
          this.logger.info(`[PubSub] Pairing code updated after token refresh: ${newCode}`);
        }
      } catch (err: any) {
        this.logger.error(`[PubSub] Re-registration after token refresh failed: ${err.message}`);
      }
    }
  }

  // ─── Polling ───────────────────────────────────────────

  private startPolling(): void {
    this.logger.info(`[PubSub] Polling ${this.subscriptionPath} every ${this.pollIntervalMs}ms`);

    // Immediate first pull
    this.pull();

    this.pollTimer = setInterval(() => {
      if (!this.isPolling) {
        this.pull();
      }
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Pull messages from the subscription, decode, deduplicate, and fire events.
   */
  async pull(): Promise<void> {
    if (this.disposed || this.isPolling) return;
    this.isPolling = true;

    try {
      const token = await this.tokenProvider.getToken();
      const resp = await this.http.post(
        `${PUBSUB_API_BASE_URL}/${this.subscriptionPath}:pull`,
        { maxMessages: this.maxMessagesPerPull },
        token,
      );

      if (!resp.ok) {
        this.pollFailures++;
        const errText = await resp.text();
        this.logger.error(`[PubSub] Pull failed (${resp.status}): ${errText}`);

        if (this.pollFailures >= PubSubTransport.MAX_POLL_RETRIES && this.connected) {
          this.logger.error(`[PubSub] ${PubSubTransport.MAX_POLL_RETRIES} consecutive pull failures — disconnecting`);
          this.connected = false;
          this.onDisconnected.fire();
        }
        this.isPolling = false;
        return;
      }

      // Success — reset failure counter
      this.pollFailures = 0;

      const result = await resp.json();
      const messages = result.receivedMessages || [];

      if (messages.length === 0) {
        this.isPolling = false;
        return;
      }

      this.logger.info(`[PubSub] Pulled ${messages.length} message(s)`);
      const ackIds: string[] = [];

      for (const received of messages) {
        ackIds.push(received.ackId);

        try {
          const raw = Buffer.from(received.message.data, 'base64').toString('utf-8');
          const envelope: PubSubEnvelope = fromAvroJson(JSON.parse(raw));

          // Deduplication
          if (this.processedIds.has(envelope.id)) {
            this.logger.info(`[PubSub] Skipping duplicate: ${envelope.id}`);
            continue;
          }
          this.trackProcessedId(envelope.id);

          // Only process messages directed to the extension from this user
          if (envelope.direction !== 'mobile_to_ext') continue;
          if (envelope.userId !== this.userId) continue;

          this.routeMessage(envelope);
        } catch (err: any) {
          this.logger.error(`[PubSub] Failed to parse message: ${err.message}`);
        }
      }

      // Acknowledge all messages (including malformed ones to prevent redelivery)
      if (ackIds.length > 0) {
        await this.http.post(
          `${PUBSUB_API_BASE_URL}/${this.subscriptionPath}:acknowledge`,
          { ackIds },
          token,
        );
      }
    } catch (err: any) {
      this.pollFailures++;
      this.logger.error(`[PubSub] Pull error: ${err.message}`);

      if (this.pollFailures >= PubSubTransport.MAX_POLL_RETRIES && this.connected) {
        this.logger.error(`[PubSub] ${PubSubTransport.MAX_POLL_RETRIES} consecutive pull failures — disconnecting`);
        this.connected = false;
        this.onDisconnected.fire();
      }
    }

    this.isPolling = false;
  }

  /**
   * Route a decoded envelope to the appropriate event emitter.
   */
  private routeMessage(envelope: PubSubEnvelope): void {
    switch (envelope.messageType) {
      case 'rpc':
        // Fire the raw RPC JSON so server.ts can handle it identically to relay
        this.logger.info(`[PubSub] RPC message received (${envelope.payload.length} bytes)`);
        this.onMessage.fire(envelope.payload);
        break;

      case 'pairing':
        this.clientCount++;
        this.logger.info(`[PubSub] Mobile client paired (${this.clientCount} total)`);
        this.onClientJoined.fire({ clientCount: this.clientCount });
        break;

      case 'disconnect':
        this.clientCount = Math.max(0, this.clientCount - 1);
        this.logger.info(`[PubSub] Mobile client disconnected (${this.clientCount} remaining)`);
        this.onClientLeft.fire({ clientCount: this.clientCount });
        break;

      case 'heartbeat':
        // No-op — just proves the channel is alive
        break;

      default:
        this.logger.info(`[PubSub] Unknown message type: ${envelope.messageType}`);
    }
  }

  // ─── Health Checks ─────────────────────────────────────

  private startHealthChecks(): void {
    this.healthTimer = setInterval(async () => {
      try {
        const healthy = await this.healthCheck();
        if (!healthy && this.connected) {
          this.logger.error('[PubSub] Health check failed — marking disconnected');
          this.connected = false;
          this.onDisconnected.fire();
        }
      } catch {
        // Swallow — health check errors are logged inside healthCheck()
      }
    }, PUBSUB_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthChecks(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Verify that credentials are valid and the subscription is reachable.
   * Retries up to 3 times with exponential backoff before returning false.
   */
  async healthCheck(): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const token = await this.tokenProvider.getToken();
        const resp = await this.http.post(
          `${PUBSUB_API_BASE_URL}/${this.subscriptionPath}:pull`,
          { maxMessages: 1 },
          token,
        );
        if (resp.ok) return true;
        this.logger.error(`[PubSub] Health check attempt ${attempt}/3 failed (${resp.status})`);
      } catch (err: any) {
        this.logger.error(`[PubSub] Health check attempt ${attempt}/3 error: ${err.message}`);
      }
      // Brief pause between retries (except last)
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs * attempt));
      }
    }
    return false;
  }

  // ─── Helpers ───────────────────────────────────────────

  /**
   * Track a processed message ID for deduplication.
   * Caps the set at MAX_PROCESSED_IDS to prevent unbounded growth.
   */
  private trackProcessedId(id: string): void {
    this.processedIds.add(id);
    if (this.processedIds.size > PubSubTransport.MAX_PROCESSED_IDS) {
      // Remove oldest entries (Set iteration order is insertion order)
      const toRemove = this.processedIds.size - PubSubTransport.MAX_PROCESSED_IDS;
      let removed = 0;
      for (const oldId of this.processedIds) {
        if (removed >= toRemove) break;
        this.processedIds.delete(oldId);
        removed++;
      }
    }
  }
}
