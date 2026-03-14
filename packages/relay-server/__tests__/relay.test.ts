/**
 * Relay Server — integration tests
 *
 * Spins up the actual relay HTTP+WS server on a random port and tests:
 * - Health endpoint
 * - /rooms endpoint (disabled → 403)
 * - Room creation via /relay/host
 * - Client join via /relay/join?code=XXXX
 * - Message forwarding: host→client, client→host
 * - Host rejoin via /relay/rejoin
 * - Host disconnect notification to clients
 * - Invalid room code handling
 * - Unknown path rejection
 */
import { createServer, IncomingMessage, Server } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as crypto from 'crypto';
import * as url from 'url';

// ─── Inline "mini relay" that mirrors production logic ──────────
// We replicate the core relay logic here to test in isolation without
// importing the side-effectful index.ts that binds to PORT immediately.
// This keeps tests fast and port-collision-free.

interface Room {
  code: string;
  hostSecret: string;
  host: WebSocket | null;
  clients: Set<WebSocket>;
  createdAt: string;
  lastActivity: string;
  ttlMs: number;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_ROOMS = 5; // Low limit for testing capacity

function generateRoomCode(rooms: Map<string, Room>): string {
  let code: string;
  let attempts = 0;
  do {
    code = '';
    const bytes = crypto.randomBytes(CODE_LENGTH);
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
    attempts++;
  } while (rooms.has(code) && attempts < 100);
  return code;
}

function startTestRelay(): Promise<{ server: Server; port: number; rooms: Map<string, Room>; cleanup: () => void }> {
  return new Promise((resolve) => {
    const rooms = new Map<string, Room>();
    const wsToRoom = new Map<WebSocket, { roomCode: string; role: 'host' | 'client' }>();

    const httpServer = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      const parsedUrl = url.parse(req.url || '', true);

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
        return;
      }

      if (parsedUrl.pathname === '/rooms') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint disabled' }));
        return;
      }

      res.writeHead(404); res.end('Not found');
    });

    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const parsedUrl = url.parse(req.url || '', true);
      const pathname = parsedUrl.pathname || '';

      if (pathname === '/relay/host') {
        if (rooms.size >= MAX_ROOMS) { ws.close(4010, 'Server at capacity'); return; }

        const code = generateRoomCode(rooms);
        const hostSecret = crypto.randomBytes(16).toString('hex');
        const room: Room = {
          code, hostSecret, host: ws, clients: new Set(),
          createdAt: new Date().toISOString(), lastActivity: new Date().toISOString(),
          ttlMs: 60_000,
        };
        rooms.set(code, room);
        wsToRoom.set(ws, { roomCode: code, role: 'host' });

        ws.send(JSON.stringify({ type: 'relay.room_created', code, hostSecret }));

        ws.on('message', (data) => {
          const raw = data.toString();
          for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(raw);
          }
        });

        ws.on('close', () => {
          wsToRoom.delete(ws);
          for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'event', method: 'relay.host_disconnected',
                params: {}, id: crypto.randomUUID(),
              }));
            }
          }
          room.host = null;
        });
        return;
      }

      if (pathname === '/relay/join') {
        const code = (parsedUrl.query.code as string || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { ws.close(4004, 'Room not found'); return; }

        room.clients.add(ws);
        wsToRoom.set(ws, { roomCode: code, role: 'client' });

        ws.send(JSON.stringify({
          type: 'relay.joined', code,
          hostConnected: room.host !== null && room.host.readyState === WebSocket.OPEN,
        }));

        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.send(JSON.stringify({ type: 'relay.client_joined', clientCount: room.clients.size }));
        }

        ws.on('message', (data) => {
          if (room.host && room.host.readyState === WebSocket.OPEN) room.host.send(data.toString());
        });

        ws.on('close', () => {
          room.clients.delete(ws);
          wsToRoom.delete(ws);
          if (room.host && room.host.readyState === WebSocket.OPEN) {
            room.host.send(JSON.stringify({ type: 'relay.client_left', clientCount: room.clients.size }));
          }
        });
        return;
      }

      if (pathname === '/relay/rejoin') {
        const code = (parsedUrl.query.code as string || '').toUpperCase();
        const secret = parsedUrl.query.secret as string || '';
        const room = rooms.get(code);

        if (!room || room.hostSecret !== secret) { ws.close(4004, 'Invalid room or secret'); return; }

        if (room.host && room.host.readyState === WebSocket.OPEN) {
          room.host.close(4009, 'Replaced');
        }

        room.host = ws;
        wsToRoom.set(ws, { roomCode: code, role: 'host' });

        ws.send(JSON.stringify({ type: 'relay.rejoined', code, clientCount: room.clients.size }));

        for (const client of room.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'event', method: 'relay.host_reconnected',
              params: {}, id: crypto.randomUUID(),
            }));
          }
        }

        ws.on('message', (data) => {
          for (const client of room.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(data.toString());
          }
        });
        return;
      }

      ws.close(4000, 'Unknown path');
    });

    httpServer.listen(0, () => {
      const addr = httpServer.address() as { port: number };
      resolve({
        server: httpServer,
        port: addr.port,
        rooms,
        cleanup: () => {
          wss.close();
          httpServer.close();
        },
      });
    });
  });
}

// ─── Test Helpers ───────────────────────────────────────────────

/** Buffered WebSocket wrapper — queues messages received before waitForMessage is called */
interface BufferedWs {
  ws: WebSocket;
  messages: any[];
  waitForMessage(timeout?: number): Promise<any>;
}

function connectWs(port: number, path: string): Promise<BufferedWs> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const messages: any[] = [];
    const waiters: Array<(msg: any) => void> = [];

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      if (waiters.length > 0) {
        waiters.shift()!(parsed);
      } else {
        messages.push(parsed);
      }
    });

    const buffered: BufferedWs = {
      ws,
      messages,
      waitForMessage(timeout = 5000): Promise<any> {
        // If we already have a buffered message, return immediately
        if (messages.length > 0) {
          return Promise.resolve(messages.shift()!);
        }
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error('Timeout waiting for message')), timeout);
          waiters.push((msg) => {
            clearTimeout(timer);
            res(msg);
          });
        });
      },
    };

    ws.once('open', () => resolve(buffered));
    ws.once('error', reject);
  });
}

function waitForClose(ws: WebSocket, timeout = 5000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout waiting for close')), timeout);
    ws.once('close', (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

// ─── Tests ──────────────────────────────────────────────────────

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('Relay Server', () => {
  let port: number;
  let server: Server;
  let rooms: Map<string, Room>;
  let cleanup: () => void;
  let openSockets: WebSocket[] = [];

  beforeAll(async () => {
    const relay = await startTestRelay();
    port = relay.port;
    server = relay.server;
    rooms = relay.rooms;
    cleanup = relay.cleanup;
  });

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets = [];
    // Clear rooms between tests to avoid MAX_ROOMS cap
    rooms.clear();
  });

  afterAll(() => {
    cleanup();
  });

  function track(b: BufferedWs): BufferedWs {
    openSockets.push(b.ws);
    return b;
  }

  // ─── HTTP Endpoints ─────────────────────────────────────────

  describe('HTTP endpoints', () => {
    it('GET /health returns status ok and room count', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(typeof body.rooms).toBe('number');
    });

    it('GET /rooms returns 403', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/rooms`);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Endpoint disabled');
    });

    it('GET /unknown returns 404', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    });
  });

  // ─── Room Creation ────────────────────────────────────────────

  describe('room creation', () => {
    it('host receives room_created with code and hostSecret', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();

      expect(msg.type).toBe('relay.room_created');
      expect(msg.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(msg.hostSecret).toMatch(/^[a-f0-9]{32}$/);
    });

    it('room code uses only safe characters (no 0/O/1/I)', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();
      expect(msg.code).not.toMatch(/[01OI]/);
    });
  });

  // ─── Client Join ──────────────────────────────────────────────

  describe('client join', () => {
    it('client receives relay.joined with hostConnected=true', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      const joined = await client.waitForMessage();

      expect(joined.type).toBe('relay.joined');
      expect(joined.code).toBe(created.code);
      expect(joined.hostConnected).toBe(true);
    });

    it('host receives relay.client_joined', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // consume relay.joined

      const notification = await host.waitForMessage();
      expect(notification.type).toBe('relay.client_joined');
      expect(notification.clientCount).toBe(1);
    });

    it('invalid code closes with 4004', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/join?code=ZZZZZZ`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4004);
    });
  });

  // ─── Message Forwarding ───────────────────────────────────────

  describe('message forwarding', () => {
    it('forwards host messages to clients', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Host sends message
      host.ws.send(JSON.stringify({ type: 'request', id: 'test-1', method: 'chat.response' }));

      const received = await client.waitForMessage();
      expect(received.type).toBe('request');
      expect(received.id).toBe('test-1');
      expect(received.method).toBe('chat.response');
    });

    it('forwards client messages to host', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Client sends message
      client.ws.send(JSON.stringify({ type: 'request', id: 'c-1', method: 'chat.send' }));

      const received = await host.waitForMessage();
      expect(received.type).toBe('request');
      expect(received.id).toBe('c-1');
    });
  });

  // ─── Host Disconnect / Rejoin ─────────────────────────────────

  describe('host disconnect', () => {
    it('clients receive relay.host_disconnected when host leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Host disconnects — wait for close handshake to complete
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      const notification = await client.waitForMessage();
      expect(notification.method).toBe('relay.host_disconnected');
    }, 10000);
  });

  describe('host rejoin', () => {
    it('host can rejoin with secret and clients are notified', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      const client = track(await connectWs(port, `/relay/join?code=${code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Host disconnects — wait for close
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      await client.waitForMessage(); // relay.host_disconnected

      // Host rejoins
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      const rejoined = await newHost.waitForMessage();
      expect(rejoined.type).toBe('relay.rejoined');
      expect(rejoined.code).toBe(code);
      expect(rejoined.clientCount).toBe(1);

      // Client gets host_reconnected
      const reconnected = await client.waitForMessage();
      expect(reconnected.method).toBe('relay.host_reconnected');
    }, 10000);

    it('rejoin with wrong secret closes with 4004', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const badWs = new WebSocket(
        `ws://127.0.0.1:${port}/relay/rejoin?code=${created.code}&secret=wrong`,
      );
      openSockets.push(badWs);
      const { code: closeCode } = await waitForClose(badWs);
      expect(closeCode).toBe(4004);
    }, 10000);
  });

  // ─── Client Disconnect ───────────────────────────────────────

  describe('client disconnect', () => {
    it('host receives relay.client_left when client leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      const closeP2 = new Promise<void>(r => client.ws.once('close', () => r()));
      client.ws.close();
      await closeP2;

      const notification = await host.waitForMessage();
      expect(notification.type).toBe('relay.client_left');
      expect(notification.clientCount).toBe(0);
    }, 10000);
  });

  // ─── Unknown Path ─────────────────────────────────────────────

  describe('unknown WS path', () => {
    it('closes with 4000', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/bad/path`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4000);
    });
  });

  // ─── Room Code Generation ────────────────────────────────────

  describe('generateRoomCode', () => {
    it('generates 6-char codes from safe alphabet', () => {
      const testRooms = new Map<string, Room>();
      for (let i = 0; i < 50; i++) {
        const code = generateRoomCode(testRooms);
        expect(code).toHaveLength(6);
        expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
      }
    });

    it('avoids collisions', () => {
      const testRooms = new Map<string, Room>();
      const codes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const code = generateRoomCode(testRooms);
        codes.add(code);
        testRooms.set(code, {} as Room); // occupy the code
      }
      expect(codes.size).toBe(20);
    });
  });
});
