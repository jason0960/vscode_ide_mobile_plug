/**
 * Relay Server — integration tests
 *
 * Imports the ACTUAL production createRelayServer() factory and tests it
 * on a random port. No reimplementation — every line of coverage hits
 * the real relay-server/src/index.ts code.
 *
 * Covers:
 * - Health endpoint
 * - /rooms endpoint (disabled → 403)
 * - Room creation via /relay/host
 * - Client join via /relay/join?code=XXXX
 * - Message forwarding: host→client, client→host
 * - Host rejoin via /relay/rejoin
 * - Host disconnect notification to clients
 * - Client disconnect notification to host
 * - Invalid room code handling
 * - Unknown path rejection
 * - Server capacity limits
 */
import WebSocket from 'ws';
import {
  createRelayServer,
  generateRoomCode,
  RelayServerInstance,
  Room,
} from '../src/index';

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

describe('Relay Server (production code)', () => {
  let relay: RelayServerInstance;
  let port: number;
  let openSockets: WebSocket[] = [];

  beforeAll(async () => {
    relay = createRelayServer({
      port: 0,             // random port — no collisions
      maxRooms: 5,         // low cap for capacity tests
      heartbeatIntervalMs: 60_000, // slow heartbeat so it doesn't interfere
    });
    port = await relay.start();
  });

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    openSockets = [];
    // Clear rooms between tests to avoid MAX_ROOMS cap
    relay.rooms.clear();
  });

  afterAll(async () => {
    await relay.stop();
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

    it('OPTIONS returns 204 (CORS preflight)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'OPTIONS' });
      expect(res.status).toBe(204);
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

    it('room actually exists in server state after creation', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const msg = await host.waitForMessage();
      expect(relay.rooms.has(msg.code)).toBe(true);
      const room = relay.rooms.get(msg.code)!;
      expect(room.hostSecret).toBe(msg.hostSecret);
      expect(room.clients.size).toBe(0);
    });

    it('rejects host when server at capacity', async () => {
      // Fill up to maxRooms (5)
      for (let i = 0; i < 5; i++) {
        const h = track(await connectWs(port, '/relay/host'));
        await h.waitForMessage();
      }

      // 6th should be rejected
      const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/host`);
      openSockets.push(ws);
      const { code } = await waitForClose(ws);
      expect(code).toBe(4010);
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

      client.ws.send(JSON.stringify({ type: 'request', id: 'c-1', method: 'chat.send' }));

      const received = await host.waitForMessage();
      expect(received.type).toBe('request');
      expect(received.id).toBe('c-1');
    });

    it('host _relayTarget message is forwarded to all clients', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      host.ws.send(JSON.stringify({ _relayTarget: 'broadcast', data: 'hello' }));

      const received = await client.waitForMessage();
      expect(received._relayTarget).toBe('broadcast');
      expect(received.data).toBe('hello');
    });

    it('client messages when host unavailable are dropped gracefully', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Disconnect host
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      await client.waitForMessage(); // relay.host_disconnected

      // Client sends — should not throw
      client.ws.send(JSON.stringify({ type: 'request', id: 'orphan' }));
      // Give it a moment to process without crashing
      await new Promise(r => setTimeout(r, 100));
      // Server still alive — check health
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    }, 10000);
  });

  // ─── Host Disconnect / Rejoin ─────────────────────────────────

  describe('host disconnect', () => {
    it('clients receive relay.host_disconnected when host leaves', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();

      const client = track(await connectWs(port, `/relay/join?code=${created.code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

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

      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;

      await client.waitForMessage(); // relay.host_disconnected

      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      const rejoined = await newHost.waitForMessage();
      expect(rejoined.type).toBe('relay.rejoined');
      expect(rejoined.code).toBe(code);
      expect(rejoined.clientCount).toBe(1);

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

    it('rejoin replaces old host connection', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      // Rejoin while old host is still connected — old host gets closed with 4009
      const hostCloseP = waitForClose(host.ws);
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      const rejoined = await newHost.waitForMessage();
      expect(rejoined.type).toBe('relay.rejoined');

      const { code: oldCloseCode } = await hostCloseP;
      expect(oldCloseCode).toBe(4009);
    }, 10000);

    it('message forwarding works after rejoin', async () => {
      const host = track(await connectWs(port, '/relay/host'));
      const created = await host.waitForMessage();
      const { code, hostSecret } = created;

      const client = track(await connectWs(port, `/relay/join?code=${code}`));
      await client.waitForMessage(); // relay.joined
      await host.waitForMessage(); // relay.client_joined

      // Disconnect original host
      const closeP = new Promise<void>(r => host.ws.once('close', () => r()));
      host.ws.close();
      await closeP;
      await client.waitForMessage(); // relay.host_disconnected

      // Rejoin
      const newHost = track(await connectWs(port, `/relay/rejoin?code=${code}&secret=${hostSecret}`));
      await newHost.waitForMessage(); // relay.rejoined
      await client.waitForMessage(); // relay.host_reconnected

      // New host sends message → client receives
      newHost.ws.send(JSON.stringify({ type: 'test', id: 'after-rejoin' }));
      const received = await client.waitForMessage();
      expect(received.type).toBe('test');
      expect(received.id).toBe('after-rejoin');
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

  // ─── Room Code Generation (using production export) ──────────

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
        testRooms.set(code, {} as Room);
      }
      expect(codes.size).toBe(20);
    });
  });
});
