/**
 * RpcHandler — unit tests
 *
 * Covers: onRequest, onStream, handleMessage, sendRequest, sendEvent,
 * broadcastEvent, response/error pairing, timeouts, malformed JSON,
 * unknown methods, and readyState gating.
 */
import { RpcHandler, createMessageId } from '../src/rpc';
import type { RpcMessage } from '../src/types';

// ─── Mock WebSocket ─────────────────────────────────────────────

function createMockWs(readyState = 1 /* OPEN */): any {
  return {
    OPEN: 1,
    readyState,
    send: jest.fn(),
  };
}

// Patch WebSocket.OPEN so `sendEvent` guard works
jest.mock('ws', () => {
  return {
    __esModule: true,
    default: class MockWebSocket {
      static OPEN = 1;
      OPEN = 1;
      readyState = 1;
      send = jest.fn();
    },
    OPEN: 1,
  };
});

// Make WebSocket.OPEN accessible in production code
const WS = require('ws');
(WS as any).OPEN = 1;
(WS.default as any).OPEN = 1;

describe('RpcHandler', () => {
  let rpc: RpcHandler;
  let ws: ReturnType<typeof createMockWs>;

  beforeEach(() => {
    rpc = new RpcHandler();
    ws = createMockWs();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ─── createMessageId ──────────────────────────────────────────

  describe('createMessageId', () => {
    it('returns a valid UUID string', () => {
      const id = createMessageId();
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('returns unique IDs', () => {
      const ids = new Set(Array.from({ length: 50 }, () => createMessageId()));
      expect(ids.size).toBe(50);
    });
  });

  // ─── handleMessage — request routing ──────────────────────────

  describe('handleMessage — request routing', () => {
    it('routes to registered request handler and sends response', async () => {
      rpc.onRequest('test.echo', async (params) => ({ echo: params.msg }));

      const msg: RpcMessage = {
        id: 'req-1',
        type: 'request',
        method: 'test.echo',
        params: { msg: 'hello' },
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response).toMatchObject({
        id: 'req-1',
        type: 'response',
        result: { echo: 'hello' },
      });
    });

    it('returns -32601 for unknown method', async () => {
      const msg: RpcMessage = {
        id: 'req-2',
        type: 'request',
        method: 'nonExistent',
        params: {},
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.type).toBe('error');
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('nonExistent');
    });

    it('returns -32000 when handler throws', async () => {
      rpc.onRequest('fail', async () => {
        throw new Error('boom');
      });

      const msg: RpcMessage = {
        id: 'req-3',
        type: 'request',
        method: 'fail',
        params: {},
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.type).toBe('error');
      expect(response.error.code).toBe(-32000);
      expect(response.error.message).toBe('boom');
    });

    it('returns -32700 for malformed JSON', async () => {
      await rpc.handleMessage(ws, '{bad json!!!');

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.type).toBe('error');
      expect(response.error.code).toBe(-32700);
    });
  });

  // ─── handleMessage — stream routing ───────────────────────────

  describe('handleMessage — stream routing', () => {
    it('streams chunks via send callback then sends done response', async () => {
      rpc.onStream('stream.test', async (params, send) => {
        send('chunk1');
        send('chunk2');
      });

      const msg: RpcMessage = {
        id: 'stream-1',
        type: 'request',
        method: 'stream.test',
        params: {},
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      // 2 stream chunks + 1 final response
      expect(ws.send).toHaveBeenCalledTimes(3);

      const chunk1 = JSON.parse(ws.send.mock.calls[0][0]);
      expect(chunk1.type).toBe('stream');
      expect(chunk1.result).toBe('chunk1');

      const chunk2 = JSON.parse(ws.send.mock.calls[1][0]);
      expect(chunk2.type).toBe('stream');
      expect(chunk2.result).toBe('chunk2');

      const done = JSON.parse(ws.send.mock.calls[2][0]);
      expect(done).toMatchObject({
        id: 'stream-1',
        type: 'response',
        result: { done: true },
      });
    });

    it('stream handler takes priority over request handler', async () => {
      rpc.onRequest('dual', async () => ({ from: 'request' }));
      rpc.onStream('dual', async (_params, send) => {
        send('from-stream');
      });

      const msg: RpcMessage = {
        id: 's-prio',
        type: 'request',
        method: 'dual',
        params: {},
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      const first = JSON.parse(ws.send.mock.calls[0][0]);
      expect(first.type).toBe('stream');
      expect(first.result).toBe('from-stream');
    });

    it('returns -32000 when stream handler throws', async () => {
      rpc.onStream('stream.fail', async () => {
        throw new Error('stream-err');
      });

      const msg: RpcMessage = {
        id: 'sf-1',
        type: 'request',
        method: 'stream.fail',
        params: {},
      };

      await rpc.handleMessage(ws, JSON.stringify(msg));

      const response = JSON.parse(ws.send.mock.calls[0][0]);
      expect(response.type).toBe('error');
      expect(response.error.message).toBe('stream-err');
    });
  });

  // ─── handleMessage — response/error pairing ──────────────────

  describe('handleMessage — response pairing', () => {
    it('resolves pending request on response', async () => {
      const promise = rpc.sendRequest(ws, 'remote.method', { x: 1 });
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      // Simulate server sending back a response
      await rpc.handleMessage(ws, JSON.stringify({
        id: sentMsg.id,
        type: 'response',
        result: { y: 2 },
      }));

      await expect(promise).resolves.toEqual({ y: 2 });
    });

    it('rejects pending request on error response', async () => {
      const promise = rpc.sendRequest(ws, 'fail.method');
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      await rpc.handleMessage(ws, JSON.stringify({
        id: sentMsg.id,
        type: 'error',
        error: { code: -1, message: 'remote error' },
      }));

      await expect(promise).rejects.toThrow('remote error');
    });

    it('ignores response for unknown id', async () => {
      // Should not throw
      await rpc.handleMessage(ws, JSON.stringify({
        id: 'no-such-id',
        type: 'response',
        result: {},
      }));
    });
  });

  // ─── sendRequest ──────────────────────────────────────────────

  describe('sendRequest', () => {
    it('sends a properly formatted request', () => {
      rpc.sendRequest(ws, 'test.method', { key: 'val' });

      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('request');
      expect(sent.method).toBe('test.method');
      expect(sent.params).toEqual({ key: 'val' });
      expect(sent.id).toBeDefined();
    });

    it('rejects on timeout', async () => {
      const promise = rpc.sendRequest(ws, 'slow', {}, 1000);

      jest.advanceTimersByTime(1500);

      await expect(promise).rejects.toThrow('Request timeout: slow');
    });

    it('does not reject after response is received (timeout is cancelled)', async () => {
      const promise = rpc.sendRequest(ws, 'fast', {}, 5000);
      const sentMsg = JSON.parse(ws.send.mock.calls[0][0]);

      await rpc.handleMessage(ws, JSON.stringify({
        id: sentMsg.id,
        type: 'response',
        result: 'ok',
      }));

      // Advance past timeout — should NOT reject
      jest.advanceTimersByTime(6000);

      await expect(promise).resolves.toBe('ok');
    });
  });

  // ─── sendEvent ────────────────────────────────────────────────

  describe('sendEvent', () => {
    it('sends event when ws is OPEN', () => {
      rpc.sendEvent(ws, 'editor.changed', { path: '/a.ts' });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('event');
      expect(sent.method).toBe('editor.changed');
      expect(sent.params).toEqual({ path: '/a.ts' });
    });

    it('does NOT send when ws is CLOSED', () => {
      ws.readyState = 3; // CLOSED
      rpc.sendEvent(ws, 'test', {});
      expect(ws.send).not.toHaveBeenCalled();
    });
  });

  // ─── broadcastEvent ───────────────────────────────────────────

  describe('broadcastEvent', () => {
    it('sends event to all OPEN clients', () => {
      const ws1 = createMockWs(1);
      const ws2 = createMockWs(1);
      const ws3 = createMockWs(3); // CLOSED

      const clients = new Set<any>([ws1, ws2, ws3]);
      rpc.broadcastEvent(clients, 'notify', { x: 1 });

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
      expect(ws3.send).not.toHaveBeenCalled();
    });
  });

  // ─── readyState gating on private helpers ─────────────────────

  describe('readyState gating', () => {
    it('sendResponse does not send on closed ws', async () => {
      rpc.onRequest('gated', async () => 'result');
      ws.readyState = 3;

      await rpc.handleMessage(ws, JSON.stringify({
        id: 'g-1',
        type: 'request',
        method: 'gated',
        params: {},
      }));

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('sendError does not send on closed ws', async () => {
      ws.readyState = 3;
      await rpc.handleMessage(ws, '{broken');
      expect(ws.send).not.toHaveBeenCalled();
    });
  });
});
