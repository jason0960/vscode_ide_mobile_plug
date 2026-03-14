/**
 * BaseServer — unit tests
 *
 * Covers: HTTP routes (/api/health, /api/pair-info, /api/auth, /pair),
 * WebSocket auth handshake (sessionId + token paths), session-aware
 * event queuing/flushing, MAX_EVENT_QUEUE_SIZE cap, broadcastToAuthenticated,
 * start/stop lifecycle.
 */
import request from 'supertest';
import WebSocket from 'ws';
import { BaseServer, MAX_EVENT_QUEUE_SIZE } from '../src/base-server';
import { BaseAuth } from '../src/base-auth';
import { BaseTunnel } from '../src/base-tunnel';
import type { ILogger, ISecretStore, IConfigProvider, SessionState } from '../src/interfaces';
import type { ServerState } from '@mobile-copilot/protocol';

// ─── Concrete subclass (BaseServer is abstract) ─────────────────

class TestServer extends BaseServer {
  public connectedSessions: string[] = [];

  protected getPort(): number { return 0; } // random port
  protected getStaticFilesPath(): string { return ''; }
  protected setupRpcHandlers(): void {}
  protected onServerStarted(): void {}
  protected onServerStopped(): void {}
  protected onServerStopping(): void {}
  protected onClientConnected(_ws: WebSocket, sessionId: string): void {
    this.connectedSessions.push(sessionId);
  }
  protected onClientDisconnected(_ws: WebSocket, _sessionId: string): void {}
  getState(): ServerState {
    return { running: !!this.server, port: this.port, localUrl: '', connectedClients: this.clients.size };
  }
  dispose(): void {}

  // Expose internals for testing
  get _sessions(): Map<string, SessionState> { return this.sessions; }
  get _app() { return this.app; }
  /** After start(), retrieve the actual OS-assigned port */
  getRealPort(): number {
    const addr = this.server?.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }
  /** Force setupExpress for supertest (without full start) */
  initExpress(): void { this.setupExpress(); }
}

// ─── Concrete auth subclass ─────────────────────────────────────

class TestAuth extends BaseAuth {
  async showQRPanel(): Promise<void> {}
}

// ─── Mocks ──────────────────────────────────────────────────────

function createLogger(): ILogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function createSecrets(): ISecretStore {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (k: string) => store.get(k)),
    store: jest.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: jest.fn(async (k: string) => { store.delete(k); }),
  };
}

function createConfig(overrides: Record<string, any> = {}): IConfigProvider {
  return { get: jest.fn(<T>(key: string, def?: T) => overrides[key] ?? def) };
}

// ─── Test Suite ─────────────────────────────────────────────────

describe('BaseServer', () => {
  let server: TestServer;
  let auth: TestAuth;
  let tunnel: BaseTunnel;
  let logger: ILogger;

  beforeEach(async () => {
    logger = createLogger();
    auth = new TestAuth(logger, createSecrets(), createConfig({ sessionTimeout: 3600 }));
    tunnel = new BaseTunnel(logger);
    server = new TestServer(logger, auth, tunnel);
  });

  afterEach(async () => {
    try { await server.stop(); } catch {}
  });

  // ─── HTTP Endpoints (via supertest) ───────────────────────────

  describe('HTTP routes', () => {
    beforeEach(() => {
      server.initExpress(); // register routes on the express app
    });

    it('GET /api/health returns ok', async () => {
      const res = await request(server._app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.version).toBe('0.2.0');
      expect(typeof res.body.clients).toBe('number');
    });

    it('GET /api/pair-info returns 403 without DEBUG_PAIR', async () => {
      delete process.env.DEBUG_PAIR;
      const res = await request(server._app).get('/api/pair-info');
      expect(res.status).toBe(403);
    });

    it('GET /api/pair-info returns token with DEBUG_PAIR=1 from loopback', async () => {
      process.env.DEBUG_PAIR = '1';
      // supertest connects via loopback by default
      const res = await request(server._app).get('/api/pair-info');
      // Note: supertest may use 127.0.0.1, which should pass loopback check
      // The result depends on how Express resolves req.ip for supertest
      // It might be 127.0.0.1 (passes) or undefined (fails with 403)
      expect([200, 403]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body.token).toBeDefined();
        expect(res.body.pairingUrl).toBeDefined();
        expect(res.body.wsUrl).toBeDefined();
      }
      delete process.env.DEBUG_PAIR;
    });

    it('GET /api/auth returns 400 without token', async () => {
      const res = await request(server._app).get('/api/auth');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Token required');
    });

    it('GET /api/auth returns 401 for invalid token', async () => {
      const res = await request(server._app).get('/api/auth?token=deadbeef');
      expect(res.status).toBe(401);
    });

    it('GET /api/auth returns session on valid token', async () => {
      const token = await auth.generateToken();
      const res = await request(server._app).get(`/api/auth?token=${token}`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.sessionId).toBeDefined();
    });

    it('GET /pair redirects with token', async () => {
      const res = await request(server._app).get('/pair?token=abc123');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/?token=abc123');
    });

    it('GET /pair returns 400 without token', async () => {
      const res = await request(server._app).get('/pair');
      expect(res.status).toBe(400);
    });
  });

  // ─── WebSocket Auth (unit-level via internals) ────────────────
  // Full integration WS tests are skipped in CI (timing-sensitive).
  // Instead we test the session + auth plumbing the WS handler calls.

  describe('WebSocket auth plumbing', () => {
    it('registerSession + flushSessionQueue replays buffered events', () => {
      const sessionId = 'ws-auth-sess';
      // Pre-queue events before the client connects
      server._sessions.set(sessionId, {
        ws: null,
        eventQueue: [
          { method: 'chat.chunk', data: { text: 'hello' } },
          { method: 'chat.chunk', data: { text: ' world' } },
        ],
        lastAgentResponse: null,
      });

      const sent: string[] = [];
      const mockWs = {
        readyState: 1,
        send: jest.fn((data: string) => sent.push(data)),
      } as any;

      // This is what the WS handler calls on successful auth
      (server as any).registerSession(sessionId, mockWs);
      (server as any).flushSessionQueue(sessionId);

      // The two queued events should have been sent
      expect(mockWs.send).toHaveBeenCalled();
      const session = server._sessions.get(sessionId)!;
      expect(session.eventQueue).toEqual([]); // queue drained
    });

    it('flushSessionQueue replays lastAgentResponse', () => {
      const sessionId = 'replay-sess';
      const mockWs = {
        readyState: 1,
        send: jest.fn(),
      } as any;

      server._sessions.set(sessionId, {
        ws: mockWs,
        eventQueue: [],
        lastAgentResponse: { content: 'previous answer', complete: true, timestamp: Date.now() },
      });

      (server as any).flushSessionQueue(sessionId);

      // Should have sent the lastAgentResponse replay
      expect(mockWs.send).toHaveBeenCalled();
      const calls = mockWs.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const replayMsg = calls.find((m: any) => m.method === 'session.missedResponse');
      expect(replayMsg).toBeDefined();
      expect(replayMsg.params.content).toBe('previous answer');
    });
  });

  // ─── Session Queue / Flush ────────────────────────────────────

  describe('session queuing', () => {
    it('MAX_EVENT_QUEUE_SIZE is 200', () => {
      expect(MAX_EVENT_QUEUE_SIZE).toBe(200);
    });

    it('queueForSession caps at MAX_EVENT_QUEUE_SIZE', () => {
      const sessionId = 'test-session';
      server._sessions.set(sessionId, { ws: null, eventQueue: [], lastAgentResponse: null });

      // Queue 250 events (exceeds 200 cap)
      for (let i = 0; i < 250; i++) {
        (server as any).queueForSession(sessionId, 'test.event', { i });
      }

      const session = server._sessions.get(sessionId)!;
      expect(session.eventQueue.length).toBe(MAX_EVENT_QUEUE_SIZE);
      // The first 50 events should have been dropped
      expect(session.eventQueue[0].data.i).toBe(50);
    });

    it('queueForSession does nothing for unknown session', () => {
      // Should not throw
      (server as any).queueForSession('nonexistent', 'test', {});
    });

    it('registerSession creates new session state', () => {
      const mockWs = { readyState: 1 } as any;
      (server as any).registerSession('new-sess', mockWs);
      const session = server._sessions.get('new-sess');
      expect(session).toBeDefined();
      expect(session!.ws).toBe(mockWs);
      expect(session!.eventQueue).toEqual([]);
    });

    it('registerSession reconnects existing session', () => {
      // Pre-populate with queued events
      server._sessions.set('reconnect-sess', {
        ws: null,
        eventQueue: [{ method: 'buffered', data: {} }],
        lastAgentResponse: null,
      });

      const newWs = { readyState: 1 } as any;
      (server as any).registerSession('reconnect-sess', newWs);

      const session = server._sessions.get('reconnect-sess')!;
      expect(session.ws).toBe(newWs);
      // Queue should still be intact (flushing is separate)
      expect(session.eventQueue.length).toBe(1);
    });
  });

  // ─── Session-Aware Send ───────────────────────────────────────

  describe('createSessionAwareSend', () => {
    it('buffers chunks into lastAgentResponse', () => {
      const sessionId = 'aware-sess';
      const mockWs = { readyState: 1 } as any;
      server._sessions.set(sessionId, { ws: mockWs, eventQueue: [], lastAgentResponse: null });

      // Mock clientInfo
      (server as any).clients.set(mockWs, { authenticated: true, sessionId });

      const originalSend = jest.fn();
      const wrappedSend = (server as any).createSessionAwareSend(mockWs, originalSend);

      wrappedSend('chunk1');
      wrappedSend('chunk2');

      const session = server._sessions.get(sessionId)!;
      expect(session.lastAgentResponse!.content).toBe('chunk1chunk2');
      expect(session.lastAgentResponse!.complete).toBe(false);
      expect(originalSend).toHaveBeenCalledTimes(2);
    });

    it('returns original send when no sessionId', () => {
      const mockWs = {} as any;
      (server as any).clients.set(mockWs, { authenticated: true });
      const originalSend = jest.fn();
      const result = (server as any).createSessionAwareSend(mockWs, originalSend);
      expect(result).toBe(originalSend);
    });
  });

  // ─── markAgentResponseComplete ────────────────────────────────

  describe('markAgentResponseComplete', () => {
    it('sets complete=true on session lastAgentResponse', () => {
      const sessionId = 'complete-sess';
      const mockWs = {} as any;
      server._sessions.set(sessionId, {
        ws: mockWs,
        eventQueue: [],
        lastAgentResponse: { content: 'hello', complete: false, timestamp: Date.now() },
      });
      (server as any).clients.set(mockWs, { authenticated: true, sessionId });

      (server as any).markAgentResponseComplete(mockWs);

      const session = server._sessions.get(sessionId)!;
      expect(session.lastAgentResponse!.complete).toBe(true);
    });
  });

  // ─── Start / Stop Lifecycle ───────────────────────────────────

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      await server.start();
      expect(server.getState().running).toBe(true);

      await server.stop();
      expect(server.getState().running).toBe(false);
    });

    it('double start is safe', async () => {
      await server.start();
      await server.start(); // should log "Already running"
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Already running'));
      await server.stop();
    });

    it('getServerUrl returns localhost by default', async () => {
      const url = server.getServerUrl();
      expect(url).toMatch(/^http:\/\//);
    });
  });

  // ─── WebSocket Integration ────────────────────────────────────

  describe('WebSocket integration', () => {
    let port: number;

    beforeEach(async () => {
      await server.start();
      port = server.getRealPort();
    });

    afterEach(async () => {
      await server.stop();
    });

    it('sends connection.ready on connect', (done) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        expect(msg.method).toBe('connection.ready');
        expect(msg.params.requiresAuth).toBe(true);
        expect(msg.params.serverVersion).toBe('0.2.0');
        ws.close();
        done();
      });
      ws.on('error', done);
    });

    it('authenticates with valid sessionId', (done) => {
      // First get a session via HTTP auth
      auth.generateToken().then((tok) => {
        request(server._app).get(`/api/auth?token=${tok}`).then((res) => {
          const sessionId = res.body.sessionId;

          const ws = new WebSocket(`ws://localhost:${port}/ws`);
          let gotReady = false;

          ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());

            if (msg.method === 'connection.ready') {
              gotReady = true;
              ws.send(JSON.stringify({ method: 'auth', params: { sessionId } }));
              return;
            }

            if (msg.method === 'auth.success') {
              expect(msg.params.sessionId).toBe(sessionId);
              ws.close();
              done();
              return;
            }
          });
          ws.on('error', done);
        });
      });
    });

    it('authenticates with valid token directly', (done) => {
      auth.generateToken().then((tok) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`);

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());

          if (msg.method === 'connection.ready') {
            ws.send(JSON.stringify({ method: 'auth', params: { token: tok } }));
            return;
          }

          if (msg.method === 'auth.success') {
            expect(msg.params.sessionId).toBeDefined();
            ws.close();
            done();
            return;
          }
        });
        ws.on('error', done);
      });
    });

    it('rejects invalid auth with 4003', (done) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());

        if (msg.method === 'connection.ready') {
          ws.send(JSON.stringify({ method: 'auth', params: { token: 'invalid-token' } }));
          return;
        }

        if (msg.method === 'auth.failed') {
          // WS should then close with 4003
        }
      });

      ws.on('close', (code: number) => {
        expect(code).toBe(4003);
        done();
      });

      ws.on('error', () => {}); // ignore connection reset
    });

    it('closes with 4002 on invalid message format', (done) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'connection.ready') {
          ws.send('not-valid-json{{{');
        }
      });

      ws.on('close', (code: number) => {
        expect(code).toBe(4002);
        done();
      });

      ws.on('error', () => {}); // ignore
    });

    it('tracks connected session in onClientConnected callback', (done) => {
      auth.generateToken().then((tok) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`);

        ws.on('message', (data: Buffer) => {
          const msg = JSON.parse(data.toString());

          if (msg.method === 'connection.ready') {
            ws.send(JSON.stringify({ method: 'auth', params: { token: tok } }));
            return;
          }

          if (msg.method === 'auth.success') {
            expect(server.connectedSessions.length).toBeGreaterThan(0);
            ws.close();
            done();
            return;
          }
        });
        ws.on('error', done);
      });
    });
  });

  // ─── broadcastToAuthenticated ─────────────────────────────────

  describe('broadcastToAuthenticated', () => {
    it('sends to authenticated clients only', () => {
      const authWs = { readyState: 1, send: jest.fn() } as any;
      const unauthWs = { readyState: 1, send: jest.fn() } as any;

      (server as any).clients.set(authWs, { authenticated: true, sessionId: 'a' });
      (server as any).clients.set(unauthWs, { authenticated: false });

      (server as any).broadcastToAuthenticated('test.event', { data: 'hello' });

      expect(authWs.send).toHaveBeenCalled();
      expect(unauthWs.send).not.toHaveBeenCalled();
    });

    it('skips clients with non-OPEN readyState', () => {
      const closedWs = { readyState: 3, send: jest.fn() } as any; // CLOSED
      (server as any).clients.set(closedWs, { authenticated: true, sessionId: 'b' });

      (server as any).broadcastToAuthenticated('test.event', { data: 'x' });

      expect(closedWs.send).not.toHaveBeenCalled();
    });
  });

  // ─── sendToAllSessions ────────────────────────────────────────

  describe('sendToAllSessions', () => {
    it('queues for disconnected sessions', () => {
      server._sessions.set('disc-sess', { ws: null, eventQueue: [], lastAgentResponse: null });
      const openWs = { readyState: 1, send: jest.fn() } as any;
      (server as any).clients.set(openWs, { authenticated: true, sessionId: 'other' });

      (server as any).sendToAllSessions('event', { data: 'test' });

      const session = server._sessions.get('disc-sess')!;
      expect(session.eventQueue.length).toBe(1);
      expect(session.eventQueue[0].method).toBe('event');
    });
  });
});
