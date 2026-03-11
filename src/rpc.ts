import { RpcMessage, RpcError } from './types';
import * as crypto from 'crypto';
import WebSocket = require('ws');

/**
 * JSON-RPC-like protocol handler over WebSocket.
 * Supports request/response, streaming, and events.
 */
export class RpcHandler {
  private handlers: Map<string, (params: any) => Promise<any>> = new Map();
  private streamHandlers: Map<string, (params: any, send: (chunk: string) => void) => Promise<void>> =
    new Map();
  private pendingRequests: Map<string, { resolve: Function; reject: Function }> = new Map();

  /**
   * Register a request handler for a method.
   */
  onRequest(method: string, handler: (params: any) => Promise<any>): void {
    this.handlers.set(method, handler);
  }

  /**
   * Register a streaming handler for a method.
   * The handler receives a `send` callback to push stream chunks.
   */
  onStream(
    method: string,
    handler: (params: any, send: (chunk: string) => void) => Promise<void>
  ): void {
    this.streamHandlers.set(method, handler);
  }

  /**
   * Process an incoming WebSocket message.
   */
  async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.sendError(ws, 'unknown', -32700, 'Parse error');
      return;
    }

    // Log every incoming message for debugging
    if (msg.method) {
      console.log(`[RPC] Incoming: type=${msg.type} method=${msg.method} id=${msg.id}`);
    }

    if (msg.type === 'response' || msg.type === 'error') {
      // Handle response to our outgoing request
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.type === 'request' && msg.method) {
      // Check for stream handler first
      const streamHandler = this.streamHandlers.get(msg.method);
      if (streamHandler) {
        try {
          const send = (chunk: string) => {
            this.sendStream(ws, msg.id, msg.method!, chunk);
          };
          await streamHandler(msg.params, send);
          // Final message to signal stream end
          this.sendResponse(ws, msg.id, { done: true });
        } catch (err: any) {
          this.sendError(ws, msg.id, -32000, err.message || 'Stream error');
        }
        return;
      }

      // Check for regular handler
      const handler = this.handlers.get(msg.method);
      if (handler) {
        try {
          const result = await handler(msg.params);
          this.sendResponse(ws, msg.id, result);
        } catch (err: any) {
          this.sendError(ws, msg.id, -32000, err.message || 'Internal error');
        }
        return;
      }

      this.sendError(ws, msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }

  /**
   * Send a request to the client and wait for response.
   */
  sendRequest(ws: WebSocket, method: string, params?: any, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pendingRequests.set(id, { resolve, reject });

      const msg: RpcMessage = { id, type: 'request', method, params };
      ws.send(JSON.stringify(msg));

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Send an event (fire-and-forget) to a client.
   */
  sendEvent(ws: WebSocket, method: string, data: any): void {
    const msg: RpcMessage = {
      id: crypto.randomUUID(),
      type: 'event',
      method,
      params: data,
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  /**
   * Broadcast an event to all clients in a set.
   */
  broadcastEvent(clients: Set<WebSocket>, method: string, data: any): void {
    for (const ws of clients) {
      this.sendEvent(ws, method, data);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────

  private sendResponse(ws: WebSocket, id: string, result: any): void {
    const msg: RpcMessage = { id, type: 'response', result };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendStream(ws: WebSocket, id: string, method: string, chunk: string): void {
    const msg: RpcMessage = { id, type: 'stream', method, result: chunk };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private sendError(ws: WebSocket, id: string, code: number, message: string): void {
    const msg: RpcMessage = {
      id,
      type: 'error',
      error: { code, message },
    };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

/**
 * Create an RPC message ID.
 */
export function createMessageId(): string {
  return crypto.randomUUID();
}
