import express from 'express';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as path from 'path';
import * as os from 'os';
import { RpcHandler } from '@mobile-copilot/protocol';
import type { ServerState } from '@mobile-copilot/protocol';
import type { ILogger, SessionState, ClientInfo } from './interfaces';
import type { BaseAuth } from './base-auth';
import type { BaseTunnel } from './base-tunnel';

export const MAX_EVENT_QUEUE_SIZE = 200;

/**
 * Portable HTTP + WebSocket server with session-aware message buffering.
 *
 * Handles:
 *  - Express app, CORS, JSON, static file serving
 *  - WebSocket connection + auth handshake
 *  - Session registration, event queuing, reconnect flushing
 *  - Broadcast helpers
 *
 * Subclasses (e.g. VsCodeServer) add:
 *  - RPC handler registrations (chat, workspace, files, git, …)
 *  - IDE-specific capture strategies
 *  - Workspace event listeners
 *  - Status bar / UI integration
 */
export abstract class BaseServer {
  protected app: express.Application;
  protected server: import('http').Server | null = null;
  protected wss: WebSocketServer | null = null;
  public rpc: RpcHandler;
  protected port = 3847;

  protected clients = new Map<WebSocket, ClientInfo>();
  protected sessions = new Map<string, SessionState>();

  constructor(
    protected readonly logger: ILogger,
    protected readonly auth: BaseAuth,
    protected readonly tunnel: BaseTunnel,
  ) {
    this.app = express();
    this.rpc = new RpcHandler();
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.server) {
      this.logger.info('[Server] Already running');
      return;
    }

    this.port = this.getPort();
    this.setupExpress();
    this.setupRpcHandlers();

    const maxRetries = 10;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.tryListen(this.port + attempt);
        this.port = this.port + attempt;
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && attempt < maxRetries - 1) {
          this.logger.info(`[Server] Port ${this.port + attempt} in use, trying ${this.port + attempt + 1}...`);
          // Clean up for retry
          this.server = null;
          this.wss = null;
          continue;
        }
        throw err;
      }
    }
  }

  private tryListen(port: number): Promise<void> {
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.setupWebSocket();

    return new Promise((resolve, reject) => {
      this.server!.listen(port, () => {
        this.logger.info(`[Server] Listening on port ${port}`);
        this.onServerStarted();
        resolve();
      });
      this.server!.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    this.onServerStopping();

    for (const [ws] of this.clients) {
      ws.close();
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    await this.tunnel.stopTunnel();
    this.logger.info('[Server] Stopped');
    this.onServerStopped();
  }

  // ─── Express Setup ───────────────────────────────────────────

  protected setupExpress(): void {
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-ID');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    this.app.use(express.json({ limit: '10mb' }));

    // Health check
    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', version: '0.2.0', clients: this.clients.size });
    });

    // Dev pairing info — returns token + pairing URL (localhost only)
    this.app.get('/api/pair-info', async (req, res) => {
      // Only allow from localhost for security
      const ip = req.ip || req.socket.remoteAddress || '';
      if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('::ffff:127.0.0.1')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const token = await this.auth.getToken();
      const serverUrl = `http://localhost:${this.port}`;
      res.json({ token, pairingUrl: `${serverUrl}/pair?token=${token}`, wsUrl: `ws://localhost:${this.port}/ws` });
    });

    // Auth endpoint — validate token, create session
    this.app.get('/api/auth', async (req, res) => {
      const token = req.query.token as string;
      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }
      try {
        const valid = await this.auth.validateToken(token);
        if (valid) {
          const session = this.auth.createSession(req.get('user-agent'));
          res.json({ sessionId: session.id, success: true });
        } else {
          res.status(401).json({ error: 'Invalid token' });
        }
      } catch {
        res.status(401).json({ error: 'Invalid token' });
      }
    });

    // Pairing redirect — from QR code
    this.app.get('/pair', async (req, res) => {
      const token = req.query.token as string;
      if (!token) {
        return res.status(400).send('Missing token');
      }
      res.redirect(`/?token=${encodeURIComponent(token)}`);
    });

    // Static files
    const staticPath = this.getStaticFilesPath();
    if (staticPath) {
      this.app.use(
        express.static(staticPath, {
          etag: false,
          lastModified: false,
          setHeaders: (res) => {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
          },
        })
      );
    }

    // Subclass-specific routes
    this.setupAdditionalRoutes();
  }

  // ─── WebSocket Setup ─────────────────────────────────────────

  protected setupWebSocket(): void {
    this.wss!.on('connection', (ws: WebSocket, req) => {
      this.logger.info(`[WS] New connection from ${req.socket.remoteAddress}`);
      this.clients.set(ws, { authenticated: false });

      ws.on('message', async (data: Buffer) => {
        const raw = data.toString();
        const info = this.clients.get(ws);

        if (!info) {
          ws.close(4001, 'Unknown client');
          return;
        }

        // First message must be auth
        if (!info.authenticated) {
          try {
            const msg = JSON.parse(raw);

            // Accept: { method: 'auth', params: { sessionId } }
            if (msg.method === 'auth' && msg.params?.sessionId) {
              const valid = this.auth.validateSession(msg.params.sessionId);
              if (valid) {
                info.authenticated = true;
                info.sessionId = msg.params.sessionId;
                this.registerSession(msg.params.sessionId, ws);
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: msg.params.sessionId });
                this.flushSessionQueue(msg.params.sessionId);
                this.onClientConnected(ws, msg.params.sessionId);
                return;
              }
            }

            // Accept: { method: 'auth', params: { token } }
            if (msg.method === 'auth' && msg.params?.token) {
              const valid = await this.auth.validateToken(msg.params.token);
              if (valid) {
                const session = this.auth.createSession();
                info.authenticated = true;
                info.sessionId = session.id;
                this.registerSession(session.id, ws);
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: session.id });
                this.flushSessionQueue(session.id);
                this.onClientConnected(ws, session.id);
                return;
              }
            }

            this.rpc.sendEvent(ws, 'auth.failed', { error: 'Invalid credentials' });
            ws.close(4003, 'Authentication failed');
          } catch {
            ws.close(4002, 'Invalid message format');
          }
          return;
        }

        // Authenticated — handle RPC
        await this.rpc.handleMessage(ws, raw);
      });

      ws.on('close', () => {
        const info = this.clients.get(ws);
        if (info?.sessionId) {
          this.onClientDisconnected(ws, info.sessionId);
          // Keep session state for reconnection
          const session = this.sessions.get(info.sessionId);
          if (session) {
            session.ws = null;
          }
        }
        this.clients.delete(ws);
        this.logger.info(`[WS] Disconnected (${this.clients.size} remaining)`);
      });

      ws.on('error', (err) => {
        this.logger.error(`[WS] Error: ${err.message}`);
      });

      // Send connection.ready so the mobile client starts auth
      this.rpc.sendEvent(ws, 'connection.ready', {
        serverVersion: '0.2.0',
        requiresAuth: true,
      });
    });
  }

  // ─── Session-aware message buffering ─────────────────────────

  protected registerSession(sessionId: string, ws: WebSocket): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { ws, eventQueue: [], lastAgentResponse: null };
      this.sessions.set(sessionId, session);
      this.logger.info(`[Session] Created new session state: ${sessionId}`);
    } else {
      session.ws = ws;
      this.logger.info(
        `[Session] Reconnected session: ${sessionId} (${session.eventQueue.length} queued events)`
      );
    }
  }

  protected flushSessionQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    if (session.eventQueue.length > 0) {
      this.logger.info(
        `[Session] Flushing ${session.eventQueue.length} queued events for ${sessionId}`
      );
      for (const { method, data } of session.eventQueue) {
        this.rpc.sendEvent(session.ws, method, data);
      }
      session.eventQueue = [];
    }

    if (session.lastAgentResponse && session.lastAgentResponse.content.length > 0) {
      this.logger.info(
        `[Session] Replaying missed agent response (${session.lastAgentResponse.content.length} chars, ` +
        `complete=${session.lastAgentResponse.complete}) for ${sessionId}`
      );
      this.rpc.sendEvent(session.ws, 'session.missedResponse', {
        content: session.lastAgentResponse.content,
        complete: session.lastAgentResponse.complete,
        timestamp: session.lastAgentResponse.timestamp,
      });
      if (session.lastAgentResponse.complete) {
        session.lastAgentResponse = null;
      }
    }
  }

  protected queueForSession(sessionId: string, method: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.eventQueue.length >= MAX_EVENT_QUEUE_SIZE) {
      session.eventQueue.shift();
    }
    session.eventQueue.push({ method, data });
  }

  protected sendToAllSessions(method: string, data: any): void {
    this.broadcastToAuthenticated(method, data);

    for (const [sessionId, session] of this.sessions) {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        this.queueForSession(sessionId, method, data);
      }
    }
  }

  protected createSessionAwareSend(
    originalWs: WebSocket,
    originalSend: (chunk: string) => void,
  ): (chunk: string) => void {
    const clientInfo = this.clients.get(originalWs);
    const sessionId = clientInfo?.sessionId;

    if (!sessionId) {
      return originalSend;
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAgentResponse = { content: '', complete: false, timestamp: Date.now() };
    }

    return (chunk: string) => {
      const sess = this.sessions.get(sessionId);
      if (sess?.lastAgentResponse) {
        sess.lastAgentResponse.content += chunk;
        sess.lastAgentResponse.timestamp = Date.now();
      }

      if (originalWs.readyState === WebSocket.OPEN) {
        originalSend(chunk);
      } else {
        this.logger.info(
          `[Session] Buffering ${chunk.length} chars for disconnected session ${sessionId}`
        );
      }
    };
  }

  protected markAgentResponseComplete(ws: WebSocket): void {
    const clientInfo = this.clients.get(ws);
    const sessionId = clientInfo?.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.lastAgentResponse) {
      session.lastAgentResponse.complete = true;
      this.logger.info(
        `[Session] Agent response complete for ${sessionId} (${session.lastAgentResponse.content.length} chars)`
      );
    }
  }

  // ─── Broadcast ───────────────────────────────────────────────

  protected broadcastToAuthenticated(method: string, data: any): void {
    const authenticatedClients = new Set<WebSocket>();
    for (const [ws, info] of this.clients) {
      if (info.authenticated && ws.readyState === WebSocket.OPEN) {
        authenticatedClients.add(ws);
      }
    }
    this.rpc.broadcastEvent(authenticatedClients, method, data);
  }

  // ─── URL helpers ─────────────────────────────────────────────

  getServerUrl(): string {
    const tunnelUrl = this.tunnel.getTunnelUrl();
    if (tunnelUrl) return tunnelUrl;

    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return `http://${iface.address}:${this.port}`;
        }
      }
    }

    return `http://localhost:${this.port}`;
  }

  // ─── Abstract hooks for subclasses ───────────────────────────

  /** Return the port to listen on. */
  protected abstract getPort(): number;

  /** Return the path to static files (mobile-client). */
  protected abstract getStaticFilesPath(): string;

  /** Register IDE-specific RPC handlers. */
  protected abstract setupRpcHandlers(): void;

  /** Optional: add extra Express routes. */
  protected setupAdditionalRoutes(): void {}

  /** Called after server starts listening. */
  protected abstract onServerStarted(): void;

  /** Called before server shuts down. */
  protected onServerStopping(): void {}

  /** Called after server is fully stopped. */
  protected abstract onServerStopped(): void;

  /** Called when a client authenticates. */
  protected abstract onClientConnected(ws: WebSocket, sessionId: string): void;

  /** Called when a client disconnects. */
  protected abstract onClientDisconnected(ws: WebSocket, sessionId: string): void;

  /** Abstract state getter. */
  abstract getState(): ServerState;

  /** Dispose all resources. */
  abstract dispose(): void;
}
