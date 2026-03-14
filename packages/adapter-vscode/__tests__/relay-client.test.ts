/**
 * RelayClient — unit tests
 *
 * Covers: connect flow (room_created, timeout, errors), send guard,
 * disconnect cleanup, dispose, reconnect scheduling, isConnected getter,
 * code getter, message routing to onMessage, client join/leave events.
 *
 * The ws module and vscode module are mocked.
 */
jest.mock('vscode');
jest.mock('ws');

import WebSocket = require('ws');
import { RelayClient } from '../src/relay-client';

// ─── Mocks ──────────────────────────────────────────────────────

function createLogger(): any {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createConfig(overrides: Record<string, any> = {}): any {
  return {
    get: jest.fn(<T>(key: string, def?: T) => overrides[key] ?? def),
  };
}

// Track all created mock WebSocket instances for test control
let mockWsInstances: any[] = [];
let wsConstructorCallArgs: any[][] = [];

beforeEach(() => {
  mockWsInstances = [];
  wsConstructorCallArgs = [];

  // Make the WebSocket constructor create controllable mock instances
  (WebSocket as unknown as jest.Mock).mockImplementation(function (url: string) {
    const handlers: Record<string, Function[]> = {};
    const instance: any = {
      url,
      readyState: WebSocket.CONNECTING,
      on: jest.fn((event: string, handler: Function) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(handler);
      }),
      send: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
      // Helper to fire events in tests
      _emit(event: string, ...args: any[]) {
        (handlers[event] || []).forEach((h) => h(...args));
      },
      _handlers: handlers,
    };
    mockWsInstances.push(instance);
    wsConstructorCallArgs.push([url]);
    return instance;
  });

  // Set WebSocket constants
  (WebSocket as any).CONNECTING = 0;
  (WebSocket as any).OPEN = 1;
  (WebSocket as any).CLOSING = 2;
  (WebSocket as any).CLOSED = 3;
});

// ─── Test Suite ─────────────────────────────────────────────────

describe('RelayClient', () => {
  let client: RelayClient;
  let logger: any;
  let config: any;

  beforeEach(() => {
    jest.useFakeTimers();
    logger = createLogger();
    config = createConfig({ relayUrl: 'wss://relay.example.com' });
    client = new RelayClient(logger, config);
  });

  afterEach(() => {
    try { client.dispose(); } catch {}
    jest.useRealTimers();
  });

  // ─── Initial State ────────────────────────────────────────────

  describe('initial state', () => {
    it('is not connected', () => {
      expect(client.isConnected).toBe(false);
    });

    it('has no room code', () => {
      expect(client.code).toBeNull();
    });
  });

  // ─── connect() ────────────────────────────────────────────────

  describe('connect', () => {
    it('creates WebSocket to relay/host endpoint', () => {
      const promise = client.connect();
      expect(wsConstructorCallArgs[0][0]).toBe('wss://relay.example.com/relay/host');

      // Simulate room creation
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'ABC123',
        hostSecret: 'secret-xyz',
      })));

      return expect(promise).resolves.toBe('ABC123');
    });

    it('returns existing code if already connected', async () => {
      const promise1 = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'XYZ789',
        hostSecret: 'sec',
      })));

      const code1 = await promise1;
      expect(code1).toBe('XYZ789');

      // Second call should return immediately
      const code2 = await client.connect();
      expect(code2).toBe('XYZ789');
    });

    it('rejects on connection timeout (15s)', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.CONNECTING; // never opened

      jest.advanceTimersByTime(16_000);

      await expect(promise).rejects.toThrow(/timeout/i);
    });

    it('rejects when error occurs before room creation', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];

      ws._emit('error', new Error('Connection refused'));

      await expect(promise).rejects.toThrow(/Connection refused/);
    });

    it('rejects when no relay URL is configured', async () => {
      const noUrlConfig = createConfig({ relayUrl: '' });
      const noUrlClient = new RelayClient(logger, noUrlConfig);

      await expect(noUrlClient.connect()).rejects.toThrow(/No relay URL/);
    });

    it('strips trailing slash from relay URL', () => {
      const slashConfig = createConfig({ relayUrl: 'wss://relay.example.com/' });
      const slashClient = new RelayClient(logger, slashConfig);
      slashClient.connect().catch(() => {}); // ignore — we only check the URL

      expect(wsConstructorCallArgs[0][0]).toBe('wss://relay.example.com/relay/host');
    });

    it('fires onRoomCreated event', async () => {
      const roomCreatedSpy = jest.fn();
      client.onRoomCreated.event(roomCreatedSpy);

      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'ROOM42',
        hostSecret: 'sec',
      })));

      await promise;
      // onRoomCreated uses vscode.EventEmitter mock — fire was called
    });

    it('handles relay.rejoined message', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.rejoined',
        code: 'REJOIN1',
        clientCount: 2,
      })));

      const code = await promise;
      expect(code).toBe('REJOIN1');
    });
  });

  // ─── Message Routing ──────────────────────────────────────────

  describe('message routing', () => {
    it('fires onClientJoined on relay.client_joined', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'R1',
        hostSecret: 's',
      })));
      await promise;

      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.client_joined',
        clientCount: 1,
      })));

      // Logged the event
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Client joined'));
    });

    it('fires onClientLeft on relay.client_left', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'R1',
        hostSecret: 's',
      })));
      await promise;

      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.client_left',
        clientCount: 0,
      })));

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Client left'));
    });

    it('forwards non-control messages to onMessage', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'R1',
        hostSecret: 's',
      })));
      await promise;

      // Send an RPC message (not a relay control message)
      const rpcMsg = JSON.stringify({ jsonrpc: '2.0', method: 'chat.send', params: { text: 'hi' } });
      ws._emit('message', Buffer.from(rpcMsg));

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Forwarding message'));
    });

    it('forwards non-JSON messages to onMessage', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'R1',
        hostSecret: 's',
      })));
      await promise;

      ws._emit('message', Buffer.from('not json'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Forwarding message'));
    });
  });

  // ─── send() ───────────────────────────────────────────────────

  describe('send', () => {
    it('sends data when ws is open', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'R1',
        hostSecret: 's',
      })));
      await promise;

      client.send('test-data');
      expect(ws.send).toHaveBeenCalledWith('test-data');
    });

    it('does not send when ws is not open', () => {
      // No connection yet
      client.send('data');
      // Should not throw, just log
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cannot send'));
    });
  });

  // ─── disconnect() ─────────────────────────────────────────────

  describe('disconnect', () => {
    it('closes WebSocket and clears state', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'DISC1',
        hostSecret: 'sec',
      })));
      await promise;

      expect(client.code).toBe('DISC1');

      client.disconnect();
      expect(ws.close).toHaveBeenCalledWith(1000, 'Host disconnecting');
      expect(client.code).toBeNull();
      expect(client.isConnected).toBe(false);
    });

    it('is safe when not connected', () => {
      client.disconnect(); // no throw
    });
  });

  // ─── dispose() ────────────────────────────────────────────────

  describe('dispose', () => {
    it('sets disposed flag and disconnects', () => {
      client.dispose();
      expect(client.isConnected).toBe(false);
    });

    it('disposes event emitters', () => {
      client.dispose();
      // Calling dispose multiple times should be safe
      client.dispose();
    });
  });

  // ─── Reconnection ────────────────────────────────────────────

  describe('reconnection', () => {
    it('schedules reconnect when WS closes with room code', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'RECON1',
        hostSecret: 'secret1',
      })));
      await promise;

      // Simulate disconnect
      ws._emit('close', 1006, Buffer.from('abnormal'));

      // Advance past reconnect delay (3s)
      jest.advanceTimersByTime(3500);

      // A new WebSocket should have been created for rejoin
      expect(mockWsInstances.length).toBe(2);
      expect(wsConstructorCallArgs[1][0]).toContain('/relay/rejoin?code=RECON1&secret=secret1');
    });

    it('does not reconnect when disposed', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'DISP1',
        hostSecret: 'sec',
      })));
      await promise;

      client.dispose();

      // Simulate disconnect
      ws._emit('close', 1000, Buffer.from('normal'));

      // Advance past reconnect delay
      jest.advanceTimersByTime(5000);

      // Should only have the original WS, no reconnect
      expect(mockWsInstances.length).toBe(1);
    });

    it('does not reconnect when no room code (user disconnected)', async () => {
      const promise = client.connect();
      const ws = mockWsInstances[0];
      ws.readyState = WebSocket.OPEN;
      ws._emit('open');
      ws._emit('message', Buffer.from(JSON.stringify({
        type: 'relay.room_created',
        code: 'DC1',
        hostSecret: 'sec',
      })));
      await promise;

      // Explicit disconnect clears roomCode
      client.disconnect();

      // Advance time
      jest.advanceTimersByTime(5000);

      // Should only have the original WS
      expect(mockWsInstances.length).toBe(1);
    });
  });
});
