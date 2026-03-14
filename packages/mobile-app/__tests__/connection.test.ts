/**
 * Tests for ConnectionManager — WebSocket lifecycle, reconnect, heartbeat, URL normalization.
 * Pure TypeScript with mocked global WebSocket (no React Native deps).
 */

// ─── WebSocket Mock ─────────────────────────────────────

let wsInstances: MockWebSocket[] = [];

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;

  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  send = jest.fn();
  close = jest.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    wsInstances.push(this);
  }

  // ─── Test Helpers ───────────────────────────────────

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({ type: 'open' } as any);
  }

  simulateMessage(data: string): void {
    this.onmessage?.({ data } as any);
  }

  simulateClose(code = 1000, reason = ''): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason } as any);
  }

  simulateError(): void {
    this.onerror?.({ type: 'error' } as any);
  }
}

(global as any).WebSocket = MockWebSocket;

import { ConnectionManager } from '../src/api/connection';

// ─── Test Suite ─────────────────────────────────────────

describe('ConnectionManager', () => {
  let mgr: ConnectionManager;
  let statusChanges: string[];
  let errors: string[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    wsInstances = [];
    mgr = new ConnectionManager();
    statusChanges = [];
    errors = [];
    mgr.onStatusChange = (s) => statusChanges.push(s);
    mgr.onError = (e) => errors.push(e);
  });

  afterEach(() => {
    mgr.disconnect();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  /** Get the latest created MockWebSocket instance. */
  function latestWs(): MockWebSocket {
    return wsInstances[wsInstances.length - 1];
  }

  // ─── connectDirect ──────────────────────────────────

  describe('connectDirect', () => {
    it('normalizes http:// to ws://', () => {
      mgr.connectDirect('http://192.168.1.5:3000', 'tok');
      expect(latestWs().url).toBe('ws://192.168.1.5:3000/ws');
    });

    it('normalizes https:// to wss://', () => {
      mgr.connectDirect('https://example.com', 'tok');
      expect(latestWs().url).toBe('wss://example.com/ws');
    });

    it('appends /ws if missing', () => {
      mgr.connectDirect('ws://localhost:3000', 'tok');
      expect(latestWs().url).toBe('ws://localhost:3000/ws');
    });

    it('does not double-append /ws', () => {
      mgr.connectDirect('ws://localhost:3000/ws', 'tok');
      expect(latestWs().url).toBe('ws://localhost:3000/ws');
    });

    it('strips trailing slash before appending /ws', () => {
      mgr.connectDirect('http://localhost:3000/', 'tok');
      expect(latestWs().url).toBe('ws://localhost:3000/ws');
    });

    it('sets status to connecting immediately', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      expect(statusChanges).toContain('connecting');
    });

    it('sets status to connected on WebSocket open', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      expect(statusChanges).toContain('connected');
      expect(mgr.status).toBe('connected');
    });

    it('stores config with mode, URL, and token', () => {
      mgr.connectDirect('http://localhost:3000', 'mytoken');
      expect(mgr.currentConfig).toEqual({
        mode: 'direct',
        directUrl: 'http://localhost:3000',
        token: 'mytoken',
      });
    });

    it('delivers incoming messages via onMessage', () => {
      const messages: string[] = [];
      mgr.onMessage = (d) => messages.push(d);
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().simulateMessage('hello');
      expect(messages).toEqual(['hello']);
    });

    it('coerces non-string message data to String', () => {
      const messages: string[] = [];
      mgr.onMessage = (d) => messages.push(d);
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().onmessage?.({ data: 12345 } as any);
      expect(messages).toEqual(['12345']);
    });
  });

  // ─── connectRelay ───────────────────────────────────

  describe('connectRelay', () => {
    it('normalizes http:// to ws://', () => {
      mgr.connectRelay('http://relay.example.com', 'ABC123');
      expect(latestWs().url).toMatch(/^ws:\/\/relay\.example\.com/);
    });

    it('normalizes https:// to wss://', () => {
      mgr.connectRelay('https://relay.example.com', 'ABC123');
      expect(latestWs().url).toMatch(/^wss:\/\/relay\.example\.com/);
    });

    it('adds wss:// when no protocol present', () => {
      mgr.connectRelay('relay.example.com', 'ABC123');
      expect(latestWs().url).toMatch(/^wss:\/\/relay\.example\.com/);
    });

    it('preserves ws:// protocol', () => {
      mgr.connectRelay('ws://localhost:4800', 'ABC123');
      expect(latestWs().url).toMatch(/^ws:\/\/localhost:4800/);
    });

    it('preserves wss:// protocol', () => {
      mgr.connectRelay('wss://relay.example.com', 'ABC123');
      expect(latestWs().url).toMatch(/^wss:\/\/relay\.example\.com/);
    });

    it('builds correct relay URL path with /relay/join', () => {
      mgr.connectRelay('ws://localhost:4800', 'abc123');
      expect(latestWs().url).toBe('ws://localhost:4800/relay/join?code=ABC123');
    });

    it('uppercases room code', () => {
      mgr.connectRelay('ws://localhost:4800', 'xyzdef');
      expect(latestWs().url).toContain('code=XYZDEF');
    });

    it('URL-encodes room code', () => {
      mgr.connectRelay('ws://localhost:4800', 'A B+C');
      expect(latestWs().url).toContain('code=A%20B%2BC');
    });

    it('strips trailing slash from base URL', () => {
      mgr.connectRelay('http://relay.example.com/', 'ABC123');
      expect(latestWs().url).toContain('ws://relay.example.com/relay/join');
    });

    it('stores relay config with original URL and code', () => {
      mgr.connectRelay('ws://localhost:4800', 'abc123');
      expect(mgr.currentConfig).toEqual({
        mode: 'relay',
        relayUrl: 'ws://localhost:4800',
        relayCode: 'abc123',
      });
    });
  });

  // ─── disconnect ─────────────────────────────────────

  describe('disconnect', () => {
    it('closes WebSocket', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws = latestWs();
      mgr.disconnect();
      expect(ws.close).toHaveBeenCalled();
    });

    it('sets status to disconnected', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      statusChanges = [];
      mgr.disconnect();
      expect(statusChanges).toEqual(['disconnected']);
    });

    it('clears config', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      mgr.disconnect();
      expect(mgr.currentConfig).toBeNull();
    });

    it('nullifies onclose before closing to prevent reconnect trigger', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws = latestWs();
      ws.simulateOpen();
      mgr.disconnect();
      expect(ws.onclose).toBeNull();
    });

    it('is safe to call when not connected', () => {
      expect(() => mgr.disconnect()).not.toThrow();
    });

    it('cancels pending reconnect timers', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().simulateClose(1006, 'abnormal'); // triggers reconnect schedule
      mgr.disconnect(); // cancel it
      jest.advanceTimersByTime(5000);
      // Only the original WebSocket should exist — no reconnect attempted
      expect(wsInstances).toHaveLength(1);
    });
  });

  // ─── send ───────────────────────────────────────────

  describe('send', () => {
    it('sends data when WebSocket is OPEN', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      mgr.send('hello');
      expect(latestWs().send).toHaveBeenCalledWith('hello');
    });

    it('does nothing when WebSocket is still CONNECTING', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      mgr.send('hello');
      expect(latestWs().send).not.toHaveBeenCalled();
    });

    it('does nothing when no WebSocket exists', () => {
      expect(() => mgr.send('hello')).not.toThrow();
    });
  });

  // ─── Status getters ────────────────────────────────

  describe('status getters', () => {
    it('status starts as disconnected', () => {
      expect(mgr.status).toBe('disconnected');
    });

    it('isConnected is false initially', () => {
      expect(mgr.isConnected).toBe(false);
    });

    it('isConnected is true when connected', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      expect(mgr.isConnected).toBe(true);
    });

    it('isConnected is true when authenticated', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      mgr.markAuthenticated();
      expect(mgr.isConnected).toBe(true);
    });

    it('isConnected is false when connecting', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      expect(mgr.isConnected).toBe(false);
    });

    it('currentConfig is null before any connection', () => {
      expect(mgr.currentConfig).toBeNull();
    });
  });

  // ─── markAuthenticated ─────────────────────────────

  describe('markAuthenticated', () => {
    it('sets status to authenticated', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      statusChanges = [];
      mgr.markAuthenticated();
      expect(statusChanges).toEqual(['authenticated']);
      expect(mgr.status).toBe('authenticated');
    });

    it('does not fire status change if already authenticated', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      mgr.markAuthenticated();
      statusChanges = [];
      mgr.markAuthenticated();
      expect(statusChanges).toEqual([]);
    });
  });

  // ─── Reconnect logic ──────────────────────────────

  describe('reconnect logic', () => {
    it('reconnects after non-fatal close (code 1006)', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().simulateClose(1006, 'abnormal');
      expect(statusChanges).toContain('connecting');
      jest.advanceTimersByTime(3500);
      expect(wsInstances).toHaveLength(2);
    });

    it('reconnects direct mode with same URL', () => {
      mgr.connectDirect('http://192.168.1.5:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().simulateClose(1006);
      jest.advanceTimersByTime(3500);
      expect(wsInstances[1].url).toBe('ws://192.168.1.5:3000/ws');
    });

    it('reconnects relay mode with same config', () => {
      mgr.connectRelay('ws://localhost:4800', 'ABC123');
      latestWs().simulateOpen();
      latestWs().simulateClose(1006);
      jest.advanceTimersByTime(3500);
      expect(wsInstances[1].url).toBe('ws://localhost:4800/relay/join?code=ABC123');
    });

    it('does NOT reconnect on code 4003 (auth failed)', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      latestWs().simulateClose(4003);
      jest.advanceTimersByTime(5000);
      expect(wsInstances).toHaveLength(1);
      expect(errors).toContain('Authentication failed. Reconnect with new credentials.');
    });

    it('does NOT reconnect on code 4004 (room not found)', () => {
      mgr.connectRelay('ws://localhost:4800', 'BAD');
      latestWs().simulateOpen();
      latestWs().simulateClose(4004);
      jest.advanceTimersByTime(5000);
      expect(wsInstances).toHaveLength(1);
      expect(errors).toContain('Room not found. Check the room code.');
    });

    it('does NOT reconnect on code 4008 (room expired)', () => {
      mgr.connectRelay('ws://localhost:4800', 'OLD');
      latestWs().simulateOpen();
      latestWs().simulateClose(4008);
      jest.advanceTimersByTime(5000);
      expect(wsInstances).toHaveLength(1);
      expect(errors).toContain('Room expired. Get a new room code.');
    });

    it('sets status to disconnected on fatal close', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      statusChanges = [];
      latestWs().simulateClose(4003);
      expect(statusChanges).toEqual(['disconnected']);
    });

    it('does not reconnect after manual disconnect', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      mgr.disconnect();
      jest.advanceTimersByTime(5000);
      expect(wsInstances).toHaveLength(1);
    });

    it('closes old WebSocket when re-connecting', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws1 = latestWs();
      mgr.connectDirect('http://localhost:4000', 'tok2');
      expect(ws1.close).toHaveBeenCalled();
      expect(wsInstances).toHaveLength(2);
    });
  });

  // ─── Heartbeat ──────────────────────────────────────

  describe('heartbeat', () => {
    it('sends ping JSON after 25s', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      jest.advanceTimersByTime(25000);
      expect(latestWs().send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
    });

    it('sends multiple pings at 25s intervals', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      latestWs().simulateOpen();
      jest.advanceTimersByTime(75000);
      const pings = latestWs().send.mock.calls.filter(
        (c: any[]) => c[0] === JSON.stringify({ type: 'ping' }),
      );
      expect(pings).toHaveLength(3);
    });

    it('stops heartbeat on fatal close', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws = latestWs();
      ws.simulateOpen();
      ws.simulateClose(4003);
      ws.send.mockClear();
      jest.advanceTimersByTime(30000);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('stops heartbeat on disconnect', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws = latestWs();
      ws.simulateOpen();
      mgr.disconnect();
      ws.send.mockClear();
      jest.advanceTimersByTime(30000);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it('does not throw if send fails during heartbeat', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      const ws = latestWs();
      ws.simulateOpen();
      ws.send.mockImplementation(() => {
        throw new Error('send failed');
      });
      expect(() => jest.advanceTimersByTime(25000)).not.toThrow();
    });
  });

  // ─── Error handling ─────────────────────────────────

  describe('error handling', () => {
    it('fires onError when WebSocket constructor throws', () => {
      const OrigWs = (global as any).WebSocket;
      (global as any).WebSocket = class {
        constructor() { throw new Error('Network unreachable'); }
      };
      mgr.connectDirect('http://localhost:3000', 'tok');
      expect(errors[0]).toContain('Network unreachable');
      (global as any).WebSocket = OrigWs;
    });

    it('schedules reconnect after constructor failure', () => {
      const OrigWs = (global as any).WebSocket;
      let attempt = 0;
      (global as any).WebSocket = class {
        url: string;
        onopen: any; onclose: any; onmessage: any; onerror: any;
        readyState = 0;
        send = jest.fn();
        close = jest.fn();
        constructor(url: string) {
          this.url = url;
          attempt++;
          if (attempt === 1) throw new Error('Network unreachable');
          wsInstances.push(this as any);
        }
      };
      mgr.connectDirect('http://localhost:3000', 'tok');
      expect(attempt).toBe(1);
      jest.advanceTimersByTime(3500);
      expect(attempt).toBe(2);
      (global as any).WebSocket = OrigWs;
    });

    it('logs WebSocket error event without crashing', () => {
      mgr.connectDirect('http://localhost:3000', 'tok');
      expect(() => latestWs().simulateError()).not.toThrow();
    });
  });
});
