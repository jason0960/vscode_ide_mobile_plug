/**
 * Tests for RpcClient — JSON-RPC dispatch, relay handshake, streaming, timeouts.
 * Uses a mock ConnectionManager (no WebSocket needed).
 */

import { RpcClient } from '../src/api/rpc';

// ─── Mock Connection ────────────────────────────────────

interface MockConnection {
  onMessage: (raw: string) => void;
  send: jest.Mock;
  currentConfig: { mode: string } | null;
  markAuthenticated: jest.Mock;
}

function createMockConnection(mode: 'direct' | 'relay' | null = null): MockConnection {
  return {
    onMessage: () => {},
    send: jest.fn(),
    currentConfig: mode ? { mode } as any : null,
    markAuthenticated: jest.fn(),
  };
}

// ─── Test Suite ─────────────────────────────────────────

describe('RpcClient', () => {
  let conn: MockConnection;
  let rpc: RpcClient;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    conn = createMockConnection();
    rpc = new RpcClient(conn as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Simulate an incoming message from the server. */
  function receive(msg: object): void {
    conn.onMessage(JSON.stringify(msg));
  }

  /** Get the last message sent via the connection. */
  function lastSent(): any {
    const calls = conn.send.mock.calls;
    return JSON.parse(calls[calls.length - 1][0]);
  }

  /** Get all messages sent via the connection. */
  function allSent(): any[] {
    return conn.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
  }

  // ─── request ────────────────────────────────────────

  describe('request', () => {
    it('sends JSON-RPC request with correct shape', async () => {
      const p = rpc.request('workspace.info', { depth: 2 });
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'workspace.info',
        params: { depth: 2 },
      });
      expect(sent.id).toMatch(/^rn_/);
      receive({ id: sent.id, type: 'response', result: {} });
      await p;
    });

    it('resolves with result on response', async () => {
      const p = rpc.request('workspace.info');
      const id = lastSent().id;
      receive({ id, type: 'response', result: { name: 'test-ws' } });
      await expect(p).resolves.toEqual({ name: 'test-ws' });
    });

    it('rejects on error response (type=error)', async () => {
      const p = rpc.request('workspace.info');
      const id = lastSent().id;
      receive({ id, type: 'error', error: { code: -1, message: 'Not found' } });
      await expect(p).rejects.toThrow('Not found');
    });

    it('rejects on timeout with method name', async () => {
      const p = rpc.request('workspace.info', {}, 5000);
      jest.advanceTimersByTime(5500);
      await expect(p).rejects.toThrow('Request timeout: workspace.info');
    });

    it('does not reject if response arrives before timeout', async () => {
      const p = rpc.request('workspace.info', {}, 5000);
      const id = lastSent().id;
      receive({ id, type: 'response', result: 'ok' });
      await expect(p).resolves.toBe('ok');
      // Timeout fires after response — should be harmless
      jest.advanceTimersByTime(6000);
    });

    it('uses default 30s timeout', async () => {
      const p = rpc.request('slow.method');
      // Still pending at 29s
      jest.advanceTimersByTime(29000);
      const id = lastSent().id;
      receive({ id, type: 'response', result: 'ok' });
      await expect(p).resolves.toBe('ok');
    });

    it('sends without params when none provided', async () => {
      const p = rpc.request('ping');
      const sent = lastSent();
      expect(sent.params).toBeUndefined();
      receive({ id: sent.id, type: 'response', result: 'pong' });
      await p;
    });

    it('generates unique IDs across requests', () => {
      rpc.request('a').catch(() => {});
      rpc.request('b').catch(() => {});
      rpc.request('c').catch(() => {});
      const ids = allSent().map((m) => m.id);
      expect(new Set(ids).size).toBe(3);
    });
  });

  // ─── stream ─────────────────────────────────────────

  describe('stream', () => {
    it('sends request for stream method', () => {
      rpc.stream('chat.send', { prompt: 'hi' }, () => {}).catch(() => {});
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'chat.send',
        params: { prompt: 'hi' },
      });
    });

    it('calls onChunk for each stream message', async () => {
      const chunks: string[] = [];
      const p = rpc.stream('chat.send', { prompt: 'hi' }, (c) => chunks.push(c));
      const id = lastSent().id;

      receive({ id, type: 'stream', result: 'Hello' });
      receive({ id, type: 'stream', result: ' world' });
      receive({ id, type: 'response', result: null });

      await p;
      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('resolves with full accumulated text on response', async () => {
      const p = rpc.stream('chat.send', { prompt: 'hi' }, () => {});
      const id = lastSent().id;

      receive({ id, type: 'stream', result: 'Hello' });
      receive({ id, type: 'stream', result: ' world' });
      receive({ id, type: 'response', result: null });

      await expect(p).resolves.toBe('Hello world');
    });

    it('resolves with partial buffer on timeout', async () => {
      const p = rpc.stream('chat.send', { prompt: 'hi' }, () => {}, 5000);
      const id = lastSent().id;

      receive({ id, type: 'stream', result: 'partial' });
      jest.advanceTimersByTime(5500);

      await expect(p).resolves.toBe('partial');
    });

    it('fires global onStreamChunk handler', async () => {
      const globalChunks: [string, string][] = [];
      rpc.onStreamChunk = (id, chunk) => globalChunks.push([id, chunk]);

      const p = rpc.stream('chat.send', { prompt: 'hi' }, () => {});
      const id = lastSent().id;

      receive({ id, type: 'stream', result: 'data' });
      receive({ id, type: 'response', result: null });
      await p;

      expect(globalChunks).toEqual([[id, 'data']]);
    });

    it('resolves empty string when no chunks received', async () => {
      const p = rpc.stream('chat.send', { prompt: 'hi' }, () => {});
      const id = lastSent().id;
      receive({ id, type: 'response', result: null });
      await expect(p).resolves.toBe('');
    });
  });

  // ─── Relay message handling ─────────────────────────

  describe('relay message handling', () => {
    beforeEach(() => {
      conn.currentConfig = { mode: 'relay' } as any;
    });

    it('handles relay.joined with hostConnected — sends auth', () => {
      receive({ type: 'relay.joined', code: 'ABC123', hostConnected: true });
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'auth',
        params: { relay: true },
      });
    });

    it('handles relay.joined without hostConnected — does NOT send auth', () => {
      conn.send.mockClear();
      receive({ type: 'relay.joined', code: 'ABC123', hostConnected: false });
      expect(conn.send).not.toHaveBeenCalled();
    });

    it('handles host_reconnected — sends auth', () => {
      receive({ type: 'event', method: 'relay.host_reconnected' });
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'auth',
        params: { relay: true },
      });
    });

    it('handles host_disconnected — consumed silently', () => {
      conn.send.mockClear();
      receive({ type: 'event', method: 'relay.host_disconnected' });
      expect(conn.send).not.toHaveBeenCalled();
    });

    it('relay.joined is consumed and NOT forwarded as event', () => {
      const events: [string, any][] = [];
      rpc.onEvent = (m, p) => events.push([m, p]);
      receive({ type: 'relay.joined', code: 'ABC123', hostConnected: true });
      expect(events).toHaveLength(0);
    });

    it('does NOT intercept relay messages in direct mode', () => {
      conn.currentConfig = { mode: 'direct' } as any;
      const events: [string, any][] = [];
      rpc.onEvent = (m, p) => events.push([m, p]);

      receive({ type: 'event', method: 'relay.host_disconnected' });
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe('relay.host_disconnected');
    });

    it('does NOT intercept relay messages when no config', () => {
      conn.currentConfig = null;
      const events: [string, any][] = [];
      rpc.onEvent = (m, p) => events.push([m, p]);

      receive({ type: 'event', method: 'relay.host_disconnected' });
      expect(events).toHaveLength(1);
    });
  });

  // ─── Events ─────────────────────────────────────────

  describe('events', () => {
    it('calls onEvent for event messages', () => {
      const events: [string, any][] = [];
      rpc.onEvent = (m, p) => events.push([m, p]);
      receive({ type: 'event', method: 'diagnostics.changed', params: { errors: 3 } });
      expect(events).toEqual([['diagnostics.changed', { errors: 3 }]]);
    });

    it('handles event with no params', () => {
      const events: [string, any][] = [];
      rpc.onEvent = (m, p) => events.push([m, p]);
      receive({ type: 'event', method: 'connection.ready' });
      expect(events).toEqual([['connection.ready', undefined]]);
    });

    it('delivers multiple events in order', () => {
      const methods: string[] = [];
      rpc.onEvent = (m) => methods.push(m);
      receive({ type: 'event', method: 'a' });
      receive({ type: 'event', method: 'b' });
      receive({ type: 'event', method: 'c' });
      expect(methods).toEqual(['a', 'b', 'c']);
    });
  });

  // ─── authenticate ───────────────────────────────────

  describe('authenticate', () => {
    it('sends auth with sessionId', () => {
      rpc.authenticate('session-123');
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'auth',
        params: { sessionId: 'session-123' },
      });
    });

    it('sends auth with token', () => {
      rpc.authenticate(undefined, 'my-token');
      const sent = lastSent();
      expect(sent).toMatchObject({
        type: 'request',
        method: 'auth',
        params: { token: 'my-token' },
      });
    });

    it('prefers sessionId when both are provided', () => {
      rpc.authenticate('session-123', 'my-token');
      const sent = lastSent();
      expect(sent.params).toEqual({ sessionId: 'session-123' });
    });

    it('sends nothing when neither is provided', () => {
      conn.send.mockClear();
      rpc.authenticate();
      expect(conn.send).not.toHaveBeenCalled();
    });
  });

  // ─── cancelAll ──────────────────────────────────────

  describe('cancelAll', () => {
    it('rejects all pending requests with Connection closed', async () => {
      const p1 = rpc.request('method1');
      const p2 = rpc.request('method2');
      rpc.cancelAll();
      await expect(p1).rejects.toThrow('Connection closed');
      await expect(p2).rejects.toThrow('Connection closed');
    });

    it('makes subsequent timeouts harmless', async () => {
      const p = rpc.request('method1', {}, 1000);
      rpc.cancelAll();
      await expect(p).rejects.toThrow('Connection closed');
      // Timeout fires but pending map is empty — no double rejection
      expect(() => jest.advanceTimersByTime(1500)).not.toThrow();
    });
  });

  // ─── Error handling ─────────────────────────────────

  describe('error handling', () => {
    it('handles invalid JSON gracefully', () => {
      expect(() => conn.onMessage('not json at all')).not.toThrow();
      expect(console.error).toHaveBeenCalled();
    });

    it('ignores response with no matching pending request', () => {
      expect(() => receive({
        id: 'nonexistent',
        type: 'response',
        result: 'orphan',
      })).not.toThrow();
    });

    it('fires global onStreamChunk even for unknown stream IDs', () => {
      const globalChunks: any[] = [];
      rpc.onStreamChunk = (id, chunk) => globalChunks.push([id, chunk]);
      receive({ id: 'nonexistent', type: 'stream', result: 'chunk' });
      expect(globalChunks).toHaveLength(1);
    });

    it('rejects with Unknown error when error message is missing', async () => {
      const p = rpc.request('test');
      const id = lastSent().id;
      receive({ id, type: 'error', error: { code: -1 } });
      await expect(p).rejects.toThrow('Unknown error');
    });

    it('rejects with Unknown error when error object is missing entirely', async () => {
      const p = rpc.request('test');
      const id = lastSent().id;
      receive({ id, type: 'error' });
      await expect(p).rejects.toThrow('Unknown error');
    });

    it('ignores unknown message types without crashing', () => {
      expect(() => receive({ type: 'alien', id: '123' })).not.toThrow();
    });
  });

  // ─── sendRaw ──────────────────────────────────────

  describe('sendRaw', () => {
    it('serializes and sends object via connection', () => {
      rpc.sendRaw({ type: 'custom', data: 42 });
      expect(conn.send).toHaveBeenCalledWith('{"type":"custom","data":42}');
    });
  });

  // ─── handleRelayMessage (public API) ──────────────

  describe('handleRelayMessage', () => {
    it('returns true for relay.joined', () => {
      expect(rpc.handleRelayMessage({ type: 'relay.joined', code: 'X', hostConnected: false })).toBe(true);
    });

    it('returns true for relay.host_reconnected event', () => {
      expect(rpc.handleRelayMessage({ type: 'event', method: 'relay.host_reconnected' })).toBe(true);
    });

    it('returns true for relay.host_disconnected event', () => {
      expect(rpc.handleRelayMessage({ type: 'event', method: 'relay.host_disconnected' })).toBe(true);
    });

    it('returns false for unrecognized messages', () => {
      expect(rpc.handleRelayMessage({ type: 'event', method: 'diagnostics.changed' })).toBe(false);
    });

    it('returns false for non-event types', () => {
      expect(rpc.handleRelayMessage({ type: 'response', id: '123' })).toBe(false);
    });
  });
});
