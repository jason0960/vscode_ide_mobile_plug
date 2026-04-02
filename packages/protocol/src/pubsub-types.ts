/**
 * Shared Pub/Sub message types for Mobile Copilot.
 *
 * These types define the envelope format for messages exchanged between
 * the VS Code extension and mobile app over Google Cloud Pub/Sub.
 *
 * Architecture:
 *   Mobile App ──publish──▶ Topic ──subscription──▶ Extension (mobile_to_ext)
 *   Extension  ──publish──▶ Topic ──subscription──▶ Mobile App (ext_to_mobile)
 *
 * Messages carry RPC payloads inside the `payload` field (JSON-encoded).
 * The `messageType` discriminant enables efficient server-side filtering
 * and client-side routing without parsing the full payload.
 *
 * @module @mobile-copilot/protocol/pubsub-types
 */

// ─── Message Types ──────────────────────────────────────

/**
 * Direction discriminant for Pub/Sub message filtering.
 * Used as a Pub/Sub message attribute for server-side subscription filters.
 */
export type PubSubDirection = 'mobile_to_ext' | 'ext_to_mobile';

/**
 * Discriminated message type for routing.
 * Maps to RPC message types but is transport-specific.
 */
export type PubSubMessageType =
  | 'rpc'             // Full RPC message (request, response, stream, event, error)
  | 'auth'            // Authentication handshake
  | 'heartbeat'       // Keep-alive ping
  | 'pairing'         // Initial pairing handshake
  | 'disconnect'      // Graceful disconnect notification
  | 'connect'         // Connection established
  | 'token_refresh'   // Extension pushes refreshed access token
  | 'event';          // Generic event

/**
 * The canonical Pub/Sub message envelope.
 *
 * All communication between extension and mobile flows through this format.
 * The `payload` field contains a JSON-encoded `RpcMessage` for rpc-type messages.
 *
 * @example
 * ```ts
 * const msg: PubSubEnvelope = {
 *   id: crypto.randomUUID(),
 *   userId: 'user-abc',
 *   direction: 'mobile_to_ext',
 *   messageType: 'rpc',
 *   payload: JSON.stringify({ id: 'rn_1', type: 'request', method: 'chat.send', params: { prompt: 'hello' } }),
 *   timestamp: Date.now(),
 * };
 * ```
 */
export interface PubSubEnvelope {
  /** Unique message ID (UUID v4). Used for deduplication. */
  readonly id: string;

  /** User/session identifier. Used as Pub/Sub ordering key. */
  readonly userId: string;

  /** Direction of the message — determines which subscription receives it. */
  readonly direction: PubSubDirection;

  /** Message type discriminant for routing. */
  readonly messageType: PubSubMessageType;

  /** JSON-encoded payload. For `rpc` type, this is a serialized `RpcMessage`. */
  readonly payload: string;

  /** Unix timestamp (ms) when the message was created. */
  readonly timestamp: number;

  /**
   * Correlation ID linking request → response across Pub/Sub.
   * Set on responses/streams to match the original request's `id`.
   */
  readonly correlationId?: string;
}

// ─── Configuration Types ────────────────────────────────

/**
 * Configuration required to connect to a Pub/Sub topic/subscription pair.
 *
 * Shared between extension and mobile — the field names differ only
 * in which subscription each side reads from.
 */
export interface PubSubConfig {
  /** Google Cloud project ID (e.g., "my-project-123"). */
  readonly projectId: string;

  /** Pub/Sub topic name (e.g., "mobile-copilot-messages"). */
  readonly topicName: string;

  /**
   * Subscription name for this side to pull from.
   * - Extension reads from `ext-{userId}` (mobile_to_ext messages)
   * - Mobile reads from `mobile-{userId}` (ext_to_mobile messages)
   */
  readonly subscriptionName: string;
}

/**
 * Pairing payload — exchanged during initial connection setup.
 * Extension generates this and encodes it in a QR code or short code.
 * Mobile scans/enters it to establish the Pub/Sub channel.
 */
export interface PubSubPairingInfo {
  /** Google Cloud project ID. */
  readonly projectId: string;

  /** Pub/Sub topic name. */
  readonly topicName: string;

  /** Subscription for mobile to pull from (ext_to_mobile messages). */
  readonly mobileSubscription: string;

  /** Subscription for extension to pull from (mobile_to_ext messages). */
  readonly extensionSubscription: string;

  /** User/session ID for message routing. */
  readonly userId: string;

  /** Short-lived access token for Pub/Sub REST API. */
  readonly accessToken: string;

  /** Token expiry timestamp (ms). */
  readonly tokenExpiry: number;
}

// ─── Constants ──────────────────────────────────────────

/** Default Pub/Sub polling interval in milliseconds. */
export const PUBSUB_POLL_INTERVAL_MS = 2_000;

/** Maximum messages to pull per request. */
export const PUBSUB_MAX_MESSAGES_PER_PULL = 10;

/** Pub/Sub REST API base URL. */
export const PUBSUB_API_BASE_URL = 'https://pubsub.googleapis.com/v1';

/** Health check interval in milliseconds. */
export const PUBSUB_HEALTH_CHECK_INTERVAL_MS = 30_000;
