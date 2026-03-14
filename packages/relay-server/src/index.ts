import { createServer, IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import * as crypto from 'crypto';
import * as url from 'url';

// ─── Types ──────────────────────────────────────────────────────

interface Room {
  /** Short room code (6 chars, e.g. "A3F9K2") */
  code: string;
  /** Secret token only the host knows — prevents room hijacking */
  hostSecret: string;
  /** The IDE-side WebSocket (VS Code extension) */
  host: WebSocket | null;
  /** All connected mobile clients */
  clients: Set<WebSocket>;
  /** ISO timestamp of room creation */
  createdAt: string;
  /** ISO timestamp of last activity */
  lastActivity: string;
  /** Room expires after this many ms of inactivity */
  ttlMs: number;
}

// ─── Configuration ──────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4800', 10);
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS || String(4 * 60 * 60 * 1000), 10); // 4 hours
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS || '1000', 10);
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEBUG_RELAY = process.env.DEBUG_RELAY === '1';
const CODE_LENGTH = 6;

// ─── State ──────────────────────────────────────────────────────

const rooms = new Map<string, Room>();
const wsToRoom = new Map<WebSocket, { roomCode: string; role: 'host' | 'client' }>();
const alive = new Map<WebSocket, boolean>();

// ─── Room Code Generation ───────────────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I ambiguity

function generateRoomCode(): string {
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

// ─── HTTP Server ────────────────────────────────────────────────

const httpServer = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url || '', true);

  // Health check
  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      uptime: process.uptime(),
    }));
    return;
  }

  // Room info — removed for security (was leaking room codes)
  // Use /health for relay status monitoring instead
  if (parsedUrl.pathname === '/rooms' && req.method === 'GET') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint disabled' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ─── WebSocket Server ───────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname || '';

  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  // ── Host connects: POST /relay/host → creates a room ──
  if (pathname === '/relay/host') {
    handleHostConnection(ws);
    return;
  }

  // ── Client connects: /relay/join?code=XXXX ──
  if (pathname === '/relay/join') {
    const code = (parsedUrl.query.code as string || '').toUpperCase();
    handleClientConnection(ws, code);
    return;
  }

  // ── Host rejoin: /relay/rejoin?code=XXXX&secret=YYYY ──
  if (pathname === '/relay/rejoin') {
    const code = (parsedUrl.query.code as string || '').toUpperCase();
    const secret = parsedUrl.query.secret as string || '';
    handleHostRejoin(ws, code, secret);
    return;
  }

  ws.close(4000, 'Unknown path. Use /relay/host or /relay/join?code=XXXX');
});

// ─── Host Connection ────────────────────────────────────────────

function handleHostConnection(ws: WebSocket): void {
  if (rooms.size >= MAX_ROOMS) {
    ws.close(4010, 'Server at capacity');
    return;
  }

  const code = generateRoomCode();
  const hostSecret = crypto.randomBytes(16).toString('hex');

  const room: Room = {
    code,
    hostSecret,
    host: ws,
    clients: new Set(),
    createdAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    ttlMs: ROOM_TTL_MS,
  };

  rooms.set(code, room);
  wsToRoom.set(ws, { roomCode: code, role: 'host' });

  // Tell the host their room code
  ws.send(JSON.stringify({
    type: 'relay.room_created',
    code,
    hostSecret,
  }));

  log(`[Room ${code}] Created by host`);

  ws.on('message', (data) => {
    const raw = data.toString();
    room.lastActivity = new Date().toISOString();
    if (DEBUG_RELAY) { log(`[Room ${code}] HOST→CLIENTS (${raw.length} bytes): ${raw.substring(0, 300)}`); }

    // Check for relay control messages
    try {
      const msg = JSON.parse(raw);

      // Host can target a specific client or broadcast
      if (msg._relayTarget) {
        // Forward to specific client (future: multi-client)
        for (const client of room.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(raw);
          }
        }
        return;
      }
    } catch {
      // Not JSON or no relay control — forward as-is
    }

    // Forward to all clients
    log(`[Room ${code}] Forwarding to ${room.clients.size} clients`);
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  });

  ws.on('close', () => {
    log(`[Room ${code}] Host disconnected`);
    wsToRoom.delete(ws);
    alive.delete(ws);

    // Notify clients that the host left
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'event',
          method: 'relay.host_disconnected',
          params: {},
          id: crypto.randomUUID(),
        }));
      }
    }

    room.host = null;

    // Keep room alive for reconnection (host will rejoin with hostSecret)
    // Room will be cleaned up by TTL if host never returns
  });

  ws.on('error', (err) => {
    log(`[Room ${code}] Host error: ${err.message}`);
  });
}

// ─── Client Connection ──────────────────────────────────────────

function handleClientConnection(ws: WebSocket, code: string): void {
  const room = rooms.get(code);

  if (!room) {
    ws.close(4004, 'Room not found');
    return;
  }

  room.clients.add(ws);
  room.lastActivity = new Date().toISOString();
  wsToRoom.set(ws, { roomCode: code, role: 'client' });

  log(`[Room ${code}] Client joined (${room.clients.size} clients)`);

  // Tell the client the room info
  ws.send(JSON.stringify({
    type: 'relay.joined',
    code,
    hostConnected: room.host !== null && room.host.readyState === WebSocket.OPEN,
  }));

  // Notify the host that a client joined
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    room.host.send(JSON.stringify({
      type: 'relay.client_joined',
      clientCount: room.clients.size,
    }));
  }

  ws.on('message', (data) => {
    const raw = data.toString();
    room.lastActivity = new Date().toISOString();
    if (DEBUG_RELAY) { log(`[Room ${code}] CLIENT→HOST (${raw.length} bytes): ${raw.substring(0, 300)}`); }

    // Forward everything from client → host
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(raw);
      log(`[Room ${code}] Forwarded to host OK`);
    } else {
      log(`[Room ${code}] WARN: Host not available (host=${!!room.host}, readyState=${room.host?.readyState})`);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    wsToRoom.delete(ws);
    alive.delete(ws);
    log(`[Room ${code}] Client left (${room.clients.size} remaining)`);

    // Notify host
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.send(JSON.stringify({
        type: 'relay.client_left',
        clientCount: room.clients.size,
      }));
    }
  });

  ws.on('error', (err) => {
    log(`[Room ${code}] Client error: ${err.message}`);
  });
}

// ─── Host Reconnection ─────────────────────────────────────────

function handleHostRejoin(ws: WebSocket, code: string, secret: string): void {
  const room = rooms.get(code);

  if (!room || room.hostSecret !== secret) {
    ws.close(4004, 'Invalid room or secret');
    return;
  }

  // Close old host if still lingering
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    room.host.close(4009, 'Replaced by new host connection');
  }

  room.host = ws;
  room.lastActivity = new Date().toISOString();
  wsToRoom.set(ws, { roomCode: code, role: 'host' });

  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));

  ws.send(JSON.stringify({
    type: 'relay.rejoined',
    code,
    clientCount: room.clients.size,
  }));

  log(`[Room ${code}] Host rejoined (${room.clients.size} clients waiting)`);

  // Notify clients
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'event',
        method: 'relay.host_reconnected',
        params: {},
        id: crypto.randomUUID(),
      }));
    }
  }

  // Set up message forwarding (same as initial host)
  ws.on('message', (data) => {
    const raw = data.toString();
    room.lastActivity = new Date().toISOString();

    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    }
  });

  ws.on('close', () => {
    log(`[Room ${code}] Host disconnected (rejoin)`);
    wsToRoom.delete(ws);
    alive.delete(ws);
    room.host = null;

    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'event',
          method: 'relay.host_disconnected',
          params: {},
          id: crypto.randomUUID(),
        }));
      }
    }
  });

  ws.on('error', (err) => {
    log(`[Room ${code}] Host rejoin error: ${err.message}`);
  });
}

// ─── Heartbeat ──────────────────────────────────────────────────

const heartbeatInterval = setInterval(() => {
  for (const [ws, isAlive] of alive) {
    if (!isAlive) {
      ws.terminate();
      alive.delete(ws);
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// ─── Room Cleanup ───────────────────────────────────────────────

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const lastActivity = new Date(room.lastActivity).getTime();
    if (now - lastActivity > room.ttlMs) {
      log(`[Room ${code}] Expired — cleaning up`);

      // Close all connections
      if (room.host && room.host.readyState === WebSocket.OPEN) {
        room.host.close(4008, 'Room expired');
      }
      for (const client of room.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(4008, 'Room expired');
        }
      }

      rooms.delete(code);
    }
  }
}, 60_000); // Check every minute

// ─── Startup ────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  log(`Mobile Copilot Relay Server listening on port ${PORT}`);
  log(`  Health check: http://localhost:${PORT}/health`);
  log(`  Room TTL: ${ROOM_TTL_MS / 1000 / 60} minutes`);
  log(`  Max rooms: ${MAX_ROOMS}`);
});

// ─── Graceful Shutdown ──────────────────────────────────────────

function shutdown() {
  log('Shutting down...');
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);

  for (const [code, room] of rooms) {
    if (room.host && room.host.readyState === WebSocket.OPEN) {
      room.host.close(1001, 'Server shutting down');
    }
    for (const client of room.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1001, 'Server shutting down');
      }
    }
  }

  wss.close();
  httpServer.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Logging ────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
