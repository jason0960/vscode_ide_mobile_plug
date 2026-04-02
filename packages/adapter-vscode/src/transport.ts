/**
 * MobileTransport — common interface for all message transports.
 *
 * Both `RelayClient` (WebSocket relay) and `PubSubTransport` (Google Cloud
 * Pub/Sub) implement this interface, allowing `VsCodeServer` to switch
 * between them via config without changing any business logic.
 *
 * ## Usage
 *
 * ```typescript
 * const transport: MobileTransport = createTransport(config, logger);
 * transport.onMessage.event((raw) => handleRpc(raw));
 * const code = await transport.connect();
 * ```
 *
 * @module MobileTransport
 */

import type * as vscode from 'vscode';
import type { PubSubPairingInfo } from '@mobile-copilot/protocol';

/**
 * Unified transport interface for mobile ↔ extension communication.
 *
 * Both RelayClient and PubSubTransport expose the same events and methods,
 * enabling transparent transport switching in VsCodeServer.
 */
export interface MobileTransport {
  // ─── State ─────────────────────────────────────────────

  /** Whether the transport is actively connected and can send/receive. */
  readonly isConnected: boolean;

  /** Connection code (relay room code or Pub/Sub pairing code). */
  readonly code: string | null;

  // ─── Events ────────────────────────────────────────────

  /** Fires when connected and ready. Payload includes the pairing code. */
  readonly onRoomCreated: vscode.EventEmitter<{ code: string }>;

  /** Fires when transport disconnects. */
  readonly onDisconnected: vscode.EventEmitter<void>;

  /** Fires when an RPC message arrives from mobile. Payload is raw JSON string. */
  readonly onMessage: vscode.EventEmitter<string>;

  /** Fires when a mobile client joins. */
  readonly onClientJoined: vscode.EventEmitter<{ clientCount: number }>;

  /** Fires when a mobile client disconnects. */
  readonly onClientLeft: vscode.EventEmitter<{ clientCount: number }>;

  // ─── Lifecycle ─────────────────────────────────────────

  /**
   * Connect to the remote endpoint and return a pairing code.
   *
   * @param overrideUrl - (Relay only) Override the configured relay URL.
   * @returns The pairing code for mobile clients.
   */
  connect(overrideUrl?: string): Promise<string>;

  /**
   * Send a raw RPC message to the connected mobile client(s).
   *
   * May be synchronous (RelayClient) or asynchronous (PubSubTransport).
   * Callers should handle the return value defensively:
   *
   * ```typescript
   * const result = transport.send(data);
   * if (result instanceof Promise) result.catch(logError);
   * ```
   */
  send(data: string): void | Promise<void>;

  /** Disconnect and stop receiving messages. */
  disconnect(): void;

  /** Dispose all resources. Called on extension deactivation. */
  dispose(): void;

  /**
   * Get pairing info for mobile client (Pub/Sub only).
   * Returns undefined for relay transport.
   */
  getPairingInfo?(): Promise<PubSubPairingInfo>;
}

/**
 * Transport type identifier for configuration.
 */
export type TransportType = 'relay' | 'pubsub';
