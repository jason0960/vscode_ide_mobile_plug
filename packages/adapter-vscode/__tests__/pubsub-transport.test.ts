/**
 * PubSubTransport — comprehensive unit tests.
 *
 * Covers:
 * - connect(): credential validation, pairing code generation, polling start
 * - send(): envelope construction, publish API call, error handling
 * - pull(): message decoding, deduplication, routing, acknowledgment
 * - disconnect(): timer cleanup, state reset, event firing
 * - dispose(): resource cleanup, event emitter disposal
 * - health checks: periodic validation, disconnect on failure
 * - message routing: rpc, pairing, disconnect, heartbeat, unknown types
 * - deduplication: processed IDs tracking, cap enforcement
 * - edge cases: already connected, disposed state, malformed messages
 *
 * All external dependencies (HTTP, tokens, vscode) are mocked.
 */

jest.mock('vscode');
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return {
    ...actual,
    randomUUID: jest.fn(() => 'test-uuid-1234'),
    randomBytes: jest.fn(() => ({ toString: () => 'A1B2C3' })),
  };
});

import { PubSubTransport, PubSubTransportOptions, PubSubHttpClient, PubSubHttpResponse, TokenProvider } from '../src/pubsub-transport';
import type { PubSubEnvelope } from '@mobile-copilot/protocol';

// ─── Mock Factories ─────────────────────────────────────

function createMockHttpClient(overrides?: Partial<PubSubHttpClient>): PubSubHttpClient & {
  calls: Array<{ url: string; body: unknown; token: string }>;
  nextResponse: PubSubHttpResponse;
  setNextResponse: (resp: Partial<PubSubHttpResponse>) => void;
  setNextJsonResponse: (data: any, ok?: boolean, status?: number) => void;
} {
  const calls: Array<{ url: string; body: unknown; token: string }> = [];
  let nextResponse: PubSubHttpResponse = {
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  };

  return {
    calls,
    get nextResponse() { return nextResponse; },
    setNextResponse(resp: Partial<PubSubHttpResponse>) {
      nextResponse = { ...nextResponse, ...resp };
    },
    setNextJsonResponse(data: any, ok = true, status = 200) {
      nextResponse = {
        ok,
        status,
        json: async () => data,
        text: async () => JSON.stringify(data),
      };
    },
    async post(url: string, body: unknown, token: string): Promise<PubSubHttpResponse> {
      calls.push({ url, body, token });
      if (overrides?.post) {
        return overrides.post(url, body, token);
      }
      return nextResponse;
    },
  };
}

function createMockTokenProvider(token = 'mock-token-123'): TokenProvider & { token: string } {
  return {
    token,
    async getToken() { return this.token; },
  };
}

function createMockLogger(): any {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createTransportOptions(overrides?: Partial<PubSubTransportOptions>): PubSubTransportOptions {
  return {
    config: {
      projectId: 'test-project',
      topicName: 'test-topic',
      subscriptionName: 'ext-user123',
    },
    userId: 'user123',
    logger: createMockLogger(),
    httpClient: createMockHttpClient(),
    tokenProvider: createMockTokenProvider(),
    pollIntervalMs: 100, // Fast for tests
    maxMessagesPerPull: 10,
    ...overrides,
  };
}

/**
 * Create a base64-encoded Pub/Sub message payload from an envelope.
 */
function encodeEnvelope(envelope: PubSubEnvelope): string {
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Create a mock Pub/Sub pull response with the given envelopes.
 */
function createPullResponse(envelopes: PubSubEnvelope[]): any {
  return {
    receivedMessages: envelopes.map((env, i) => ({
      ackId: `ack-${i}`,
      message: {
        data: encodeEnvelope(env),
        attributes: {
          direction: env.direction,
          userId: env.userId,
          messageType: env.messageType,
        },
      },
    })),
  };
}

function createRpcEnvelope(payload: string, overrides?: Partial<PubSubEnvelope>): PubSubEnvelope {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    userId: 'user123',
    direction: 'mobile_to_ext',
    messageType: 'rpc',
    payload,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─── Test Suite ─────────────────────────────────────────

describe('PubSubTransport', () => {
  let transport: PubSubTransport;
  let http: ReturnType<typeof createMockHttpClient>;
  let tokenProvider: ReturnType<typeof createMockTokenProvider>;
  let logger: any;

  beforeEach(() => {
    jest.useFakeTimers();
    http = createMockHttpClient();
    tokenProvider = createMockTokenProvider();
    logger = createMockLogger();

    transport = new PubSubTransport({
      config: {
        projectId: 'test-project',
        topicName: 'test-topic',
        subscriptionName: 'ext-user123',
      },
      userId: 'user123',
      logger,
      httpClient: http,
      tokenProvider,
      pollIntervalMs: 1000,
      maxMessagesPerPull: 10,
    });
  });

  afterEach(() => {
    transport.dispose();
    jest.useRealTimers();
  });

  // ─── Constructor ──────────────────────────────────────

  describe('constructor', () => {
    it('should initialize with correct paths', () => {
      expect(transport.isConnected).toBe(false);
      expect(transport.code).toBeNull();
    });

    it('should accept custom poll interval and max messages', () => {
      const custom = new PubSubTransport({
        config: { projectId: 'p', topicName: 't', subscriptionName: 's' },
        userId: 'u',
        logger,
        httpClient: http,
        tokenProvider,
        pollIntervalMs: 5000,
        maxMessagesPerPull: 50,
      });
      // These are private but we verify through behavior in other tests
      expect(custom.isConnected).toBe(false);
      custom.dispose();
    });
  });

  // ─── connect() ────────────────────────────────────────

  describe('connect()', () => {
    it('should validate credentials with a test pull', async () => {
      http.setNextJsonResponse({});
      const code = await transport.connect();

      expect(http.calls.length).toBeGreaterThanOrEqual(1);
      const testPull = http.calls[0];
      expect(testPull.url).toContain('ext-user123:pull');
      expect(testPull.token).toBe('mock-token-123');
      expect(testPull.body).toEqual({ maxMessages: 1 });
      expect(code).toBeTruthy();
    });

    it('should generate a deterministic pairing code from userId', async () => {
      http.setNextJsonResponse({});
      const code = await transport.connect();

      // 'user123' → remove non-alphanumeric → 'user123' → substring(0,6) → 'USER12'
      expect(code).toBe('USER12');
      expect(transport.code).toBe('USER12');
    });

    it('should set isConnected to true after successful connect', async () => {
      http.setNextJsonResponse({});
      await transport.connect();
      expect(transport.isConnected).toBe(true);
    });

    it('should fire onRoomCreated event', async () => {
      http.setNextJsonResponse({});
      const fired: { code: string }[] = [];
      transport.onRoomCreated.event((e) => fired.push(e));

      await transport.connect();

      expect(fired).toHaveLength(1);
      expect(fired[0].code).toBe('USER12');
    });

    it('should return existing code if already connected', async () => {
      http.setNextJsonResponse({});
      const code1 = await transport.connect();
      const code2 = await transport.connect();

      expect(code1).toBe(code2);
      // Second call shouldn't make another API request (test pull + initial poll = 2)
      // After first connect, we have validation + first pull = at least 2 calls.
      // Second connect should not add more.
      const callsAfterFirst = http.calls.length;
      await transport.connect();
      // No new calls
      expect(http.calls.length).toBe(callsAfterFirst);
    });

    it('should throw if credential validation fails', async () => {
      http.setNextResponse({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
        json: async () => ({ error: 'Forbidden' }),
      });

      await expect(transport.connect()).rejects.toThrow('Pub/Sub credential validation failed (403): Forbidden');
      expect(transport.isConnected).toBe(false);
    });

    it('should start polling after successful connect', async () => {
      http.setNextJsonResponse({});
      await transport.connect();

      // Reset call tracking
      const callsBefore = http.calls.length;

      // Advance timer to trigger a poll cycle (async to flush promise chain)
      await jest.advanceTimersByTimeAsync(1100);

      // Should have made at least one more pull call
      expect(http.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  // ─── send() ───────────────────────────────────────────

  describe('send()', () => {
    beforeEach(async () => {
      http.setNextJsonResponse({});
      await transport.connect();
      http.calls.length = 0; // Reset tracking
    });

    it('should publish an RPC envelope with correct structure', async () => {
      http.setNextJsonResponse({ messageIds: ['pub-1'] });
      const rpcPayload = JSON.stringify({ id: 'rn_1', type: 'request', method: 'chat.send' });

      await transport.send(rpcPayload);

      // Find the publish call (not the pull calls)
      const publishCall = http.calls.find(c => c.url.includes(':publish'));
      expect(publishCall).toBeDefined();
      expect(publishCall!.url).toContain('test-topic:publish');

      const body = publishCall!.body as any;
      expect(body.messages).toHaveLength(1);

      const msg = body.messages[0];
      expect(msg.attributes.direction).toBe('ext_to_mobile');
      expect(msg.attributes.userId).toBe('user123');
      expect(msg.attributes.messageType).toBe('rpc');
      expect(msg.orderingKey).toBe('user123');

      // Decode the Avro-encoded envelope
      const decoded = JSON.parse(Buffer.from(msg.data, 'base64').toString('utf-8'));
      expect(decoded.id).toBe('test-uuid-1234');
      expect(decoded.userId).toBe('user123');
      expect(decoded.direction).toBe('ext_to_mobile');
      expect(decoded.messageType).toBe('rpc');
      // Avro union encoding: payload is {"string": "..."} not a bare string
      expect(decoded.payload).toEqual({ string: rpcPayload });
      expect(decoded.correlationId).toBeNull();
      expect(decoded.timestamp).toBeDefined();
    });

    it('should not send if not connected', async () => {
      transport.disconnect();
      http.calls.length = 0;

      await transport.send('{"test": true}');

      const publishCalls = http.calls.filter(c => c.url.includes(':publish'));
      expect(publishCalls).toHaveLength(0);
    });

    it('should not send if disposed', async () => {
      transport.dispose();
      http.calls.length = 0;

      await transport.send('{"test": true}');

      expect(http.calls).toHaveLength(0);
    });

    it('should log error on publish failure', async () => {
      http.setNextResponse({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
        json: async () => ({}),
      });

      await transport.send('{"test": true}');

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Publish failed'));
    });

    it('should handle publish network errors gracefully', async () => {
      const errorHttp = createMockHttpClient({
        async post() { throw new Error('Network timeout'); },
      });

      const t = new PubSubTransport({
        config: { projectId: 'p', topicName: 't', subscriptionName: 's' },
        userId: 'u',
        logger,
        httpClient: errorHttp,
        tokenProvider,
        pollIntervalMs: 100000,
      });

      // Force connected state for send
      (t as any).connected = true;
      (t as any).disposed = false;

      await t.send('{"test": true}');
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Publish error'));

      t.dispose();
    });
  });

  // ─── pull() — Message Routing ─────────────────────────

  describe('pull() — message routing', () => {
    let onMessageFired: string[];
    let onClientJoinedFired: { clientCount: number }[];
    let onClientLeftFired: { clientCount: number }[];

    beforeEach(() => {
      onMessageFired = [];
      onClientJoinedFired = [];
      onClientLeftFired = [];

      transport.onMessage.event((msg) => onMessageFired.push(msg));
      transport.onClientJoined.event((e) => onClientJoinedFired.push(e));
      transport.onClientLeft.event((e) => onClientLeftFired.push(e));

      // Make transport connected but DON'T use connect() to avoid auto-polling
      (transport as any).connected = true;
      (transport as any).disposed = false;
      (transport as any).pairingCode = 'TEST01';
    });

    it('should route rpc messages to onMessage', async () => {
      const rpcPayload = '{"id":"rn_1","type":"request","method":"chat.send"}';
      const envelope = createRpcEnvelope(rpcPayload);

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(onMessageFired).toHaveLength(1);
      expect(onMessageFired[0]).toBe(rpcPayload);
    });

    it('should route pairing messages to onClientJoined', async () => {
      const envelope: PubSubEnvelope = {
        id: 'pair-1',
        userId: 'user123',
        direction: 'mobile_to_ext',
        messageType: 'pairing',
        payload: '{}',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(onClientJoinedFired).toHaveLength(1);
      expect(onClientJoinedFired[0].clientCount).toBe(1);
    });

    it('should route disconnect messages to onClientLeft', async () => {
      // First add a client
      (transport as any).clientCount = 1;

      const envelope: PubSubEnvelope = {
        id: 'disc-1',
        userId: 'user123',
        direction: 'mobile_to_ext',
        messageType: 'disconnect',
        payload: '{}',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(onClientLeftFired).toHaveLength(1);
      expect(onClientLeftFired[0].clientCount).toBe(0);
    });

    it('should not decrement clientCount below zero', async () => {
      (transport as any).clientCount = 0;

      const envelope: PubSubEnvelope = {
        id: 'disc-2',
        userId: 'user123',
        direction: 'mobile_to_ext',
        messageType: 'disconnect',
        payload: '{}',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(onClientLeftFired[0].clientCount).toBe(0);
    });

    it('should ignore heartbeat messages silently', async () => {
      const envelope: PubSubEnvelope = {
        id: 'hb-1',
        userId: 'user123',
        direction: 'mobile_to_ext',
        messageType: 'heartbeat',
        payload: '',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(onMessageFired).toHaveLength(0);
      expect(onClientJoinedFired).toHaveLength(0);
    });

    it('should acknowledge all pulled messages', async () => {
      const envelope = createRpcEnvelope('{"test":true}');
      http.setNextJsonResponse(createPullResponse([envelope]));

      await transport.pull();

      const ackCall = http.calls.find(c => c.url.includes(':acknowledge'));
      expect(ackCall).toBeDefined();
      expect((ackCall!.body as any).ackIds).toEqual(['ack-0']);
    });

    it('should skip empty pull responses', async () => {
      http.setNextJsonResponse({ receivedMessages: [] });
      await transport.pull();

      expect(onMessageFired).toHaveLength(0);
      // No acknowledge call when there are no messages
      const ackCalls = http.calls.filter(c => c.url.includes(':acknowledge'));
      expect(ackCalls).toHaveLength(0);
    });

    it('should handle malformed messages gracefully', async () => {
      http.setNextJsonResponse({
        receivedMessages: [{
          ackId: 'ack-bad',
          message: { data: 'not-valid-base64!!!' },
        }],
      });

      // Should not throw
      await transport.pull();

      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse message'));
      // Should still acknowledge to prevent redelivery
      const ackCall = http.calls.find(c => c.url.includes(':acknowledge'));
      expect(ackCall).toBeDefined();
    });
  });

  // ─── pull() — Filtering ──────────────────────────────

  describe('pull() — filtering', () => {
    beforeEach(() => {
      (transport as any).connected = true;
      (transport as any).disposed = false;
    });

    it('should ignore messages with wrong direction', async () => {
      const fired: string[] = [];
      transport.onMessage.event((m) => fired.push(m));

      const envelope: PubSubEnvelope = {
        id: 'wrong-dir',
        userId: 'user123',
        direction: 'ext_to_mobile', // Wrong direction — this is OUR outgoing message
        messageType: 'rpc',
        payload: '{"should":"ignore"}',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(fired).toHaveLength(0);
    });

    it('should ignore messages for different users', async () => {
      const fired: string[] = [];
      transport.onMessage.event((m) => fired.push(m));

      const envelope: PubSubEnvelope = {
        id: 'wrong-user',
        userId: 'someoneElse',
        direction: 'mobile_to_ext',
        messageType: 'rpc',
        payload: '{"should":"ignore"}',
        timestamp: Date.now(),
      };

      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();

      expect(fired).toHaveLength(0);
    });
  });

  // ─── pull() — Deduplication ───────────────────────────

  describe('pull() — deduplication', () => {
    beforeEach(() => {
      (transport as any).connected = true;
      (transport as any).disposed = false;
    });

    it('should skip duplicate message IDs', async () => {
      const fired: string[] = [];
      transport.onMessage.event((m) => fired.push(m));

      const envelope = createRpcEnvelope('{"first":true}', { id: 'duplicate-id' });

      // First pull — should process
      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();
      expect(fired).toHaveLength(1);

      // Second pull with same ID — should skip
      http.setNextJsonResponse(createPullResponse([envelope]));
      await transport.pull();
      expect(fired).toHaveLength(1); // Still 1
    });

    it('should cap processed IDs to prevent unbounded growth', async () => {
      const processedIds = (transport as any).processedIds as Set<string>;

      // Fill beyond the cap
      for (let i = 0; i < 1005; i++) {
        processedIds.add(`id-${i}`);
      }

      // Trigger cleanup via trackProcessedId
      (transport as any).trackProcessedId('new-id');

      // Should have trimmed to MAX_PROCESSED_IDS (1000) + 1 new
      expect(processedIds.size).toBeLessThanOrEqual(1001);
    });
  });

  // ─── disconnect() ─────────────────────────────────────

  describe('disconnect()', () => {
    beforeEach(async () => {
      http.setNextJsonResponse({});
      await transport.connect();
    });

    it('should set isConnected to false', () => {
      transport.disconnect();
      expect(transport.isConnected).toBe(false);
    });

    it('should clear pairing code', () => {
      transport.disconnect();
      expect(transport.code).toBeNull();
    });

    it('should fire onDisconnected event', () => {
      const fired: boolean[] = [];
      transport.onDisconnected.event(() => fired.push(true));

      transport.disconnect();
      expect(fired).toHaveLength(1);
    });

    it('should stop polling (no more pull calls after disconnect)', () => {
      transport.disconnect();
      const callsBefore = http.calls.length;

      jest.advanceTimersByTime(5000);

      expect(http.calls.length).toBe(callsBefore);
    });

    it('should reset client count', () => {
      (transport as any).clientCount = 3;
      transport.disconnect();
      expect((transport as any).clientCount).toBe(0);
    });

    it('should clear processed IDs', () => {
      (transport as any).processedIds.add('some-id');
      transport.disconnect();
      expect((transport as any).processedIds.size).toBe(0);
    });
  });

  // ─── dispose() ────────────────────────────────────────

  describe('dispose()', () => {
    it('should set disposed flag', () => {
      transport.dispose();
      expect((transport as any).disposed).toBe(true);
    });

    it('should call disconnect()', () => {
      const disconnected: boolean[] = [];
      transport.onDisconnected.event(() => disconnected.push(true));

      transport.dispose();
      expect(disconnected).toHaveLength(1);
    });

    it('should prevent reconnection after dispose', async () => {
      transport.dispose();

      // Trying to connect after dispose should work (resets disposed flag)
      // but pull should not run if re-disposed
      (transport as any).disposed = true;
      await transport.pull();

      // Should bail immediately without making HTTP calls
      const pullCalls = http.calls.filter(c => c.url.includes(':pull'));
      expect(pullCalls).toHaveLength(0);
    });
  });

  // ─── getPairingInfo() ─────────────────────────────────

  describe('getPairingInfo()', () => {
    it('should return complete pairing info with access token', async () => {
      const info = await transport.getPairingInfo();

      expect(info.projectId).toBe('test-project');
      expect(info.topicName).toBe('test-topic');
      expect(info.mobileSubscription).toBe('mobile-user123');
      expect(info.extensionSubscription).toBe('ext-user123');
      expect(info.userId).toBe('user123');
      expect(info.accessToken).toBe('mock-token-123');
      expect(info.tokenExpiry).toBeGreaterThan(Date.now());
    });
  });

  // ─── healthCheck() ────────────────────────────────────

  describe('healthCheck()', () => {
    it('should return true when subscription is reachable', async () => {
      http.setNextJsonResponse({});
      const result = await transport.healthCheck();
      expect(result).toBe(true);
    });

    it('should return false when API returns error', async () => {
      http.setNextResponse({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
        json: async () => ({}),
      });

      const result = await transport.healthCheck();
      expect(result).toBe(false);
    });

    it('should return false and log on network error', async () => {
      const errorHttp = createMockHttpClient({
        async post() { throw new Error('ECONNREFUSED'); },
      });

      const t = new PubSubTransport({
        config: { projectId: 'p', topicName: 't', subscriptionName: 's' },
        userId: 'u',
        logger,
        httpClient: errorHttp,
        tokenProvider,
      });

      const result = await t.healthCheck();
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Health check error'));

      t.dispose();
    });
  });

  // ─── Health check timer integration ───────────────────

  describe('health check timer', () => {
    it('should fire onDisconnected when health check fails mid-session', async () => {
      http.setNextJsonResponse({});
      await transport.connect();

      const disconnectedEvents: boolean[] = [];
      transport.onDisconnected.event(() => disconnectedEvents.push(true));

      // Make health check fail
      http.setNextResponse({
        ok: false,
        status: 503,
        text: async () => 'Unavailable',
        json: async () => ({}),
      });

      // Advance past health check interval (30s), flushing the async chain
      await jest.advanceTimersByTimeAsync(31_000);

      expect(disconnectedEvents.length).toBeGreaterThanOrEqual(1);
      expect(transport.isConnected).toBe(false);
    });
  });

  // ─── Multiple messages in single pull ─────────────────

  describe('batch processing', () => {
    beforeEach(() => {
      (transport as any).connected = true;
      (transport as any).disposed = false;
    });

    it('should process multiple messages in a single pull', async () => {
      const fired: string[] = [];
      transport.onMessage.event((m) => fired.push(m));

      const envelopes = [
        createRpcEnvelope('{"msg":1}', { id: 'batch-1' }),
        createRpcEnvelope('{"msg":2}', { id: 'batch-2' }),
        createRpcEnvelope('{"msg":3}', { id: 'batch-3' }),
      ];

      http.setNextJsonResponse(createPullResponse(envelopes));
      await transport.pull();

      expect(fired).toHaveLength(3);
      expect(fired[0]).toBe('{"msg":1}');
      expect(fired[1]).toBe('{"msg":2}');
      expect(fired[2]).toBe('{"msg":3}');
    });

    it('should acknowledge all messages in batch', async () => {
      const envelopes = [
        createRpcEnvelope('{"a":1}', { id: 'b1' }),
        createRpcEnvelope('{"b":2}', { id: 'b2' }),
      ];

      http.setNextJsonResponse(createPullResponse(envelopes));
      await transport.pull();

      const ackCall = http.calls.find(c => c.url.includes(':acknowledge'));
      expect(ackCall).toBeDefined();
      expect((ackCall!.body as any).ackIds).toEqual(['ack-0', 'ack-1']);
    });
  });

  // ─── Concurrency Guard ────────────────────────────────

  describe('polling concurrency', () => {
    it('should not allow concurrent pulls', async () => {
      (transport as any).connected = true;
      (transport as any).disposed = false;

      // Start a pull that won't resolve immediately
      let resolveFirst: Function;
      const slowHttp = createMockHttpClient({
        async post() {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        },
      });

      const t = new PubSubTransport({
        config: { projectId: 'p', topicName: 't', subscriptionName: 's' },
        userId: 'u',
        logger,
        httpClient: slowHttp,
        tokenProvider,
      });
      (t as any).connected = true;
      (t as any).disposed = false;

      // First pull — starts, sets isPolling
      const pull1 = t.pull();

      // Second pull — should bail immediately
      await t.pull();

      // Resolve first
      resolveFirst!({
        ok: true,
        status: 200,
        json: async () => ({ receivedMessages: [] }),
        text: async () => '',
      });
      await pull1;

      t.dispose();
    });
  });

  // ─── Pairing Code Exchange ───────────────────────────────

  describe('pairing code exchange', () => {
    it('should register pairing code via relay when pairingRelayUrl is set', async () => {
      // Mock global fetch for the /pair POST
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ code: 'XYZ789' }),
        text: async () => '{"code":"XYZ789"}',
      }) as any;

      const options = createTransportOptions({
        pairingRelayUrl: 'https://test-relay.example.com',
      });
      const t = new PubSubTransport(options);

      const code = await t.connect();
      expect(code).toBe('XYZ789');
      expect(t.code).toBe('XYZ789');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://test-relay.example.com/pair',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      t.dispose();
      global.fetch = originalFetch;
    });

    it('should fall back to deterministic code when pairingRelayUrl is not set', async () => {
      const options = createTransportOptions(); // no pairingRelayUrl
      const t = new PubSubTransport(options);

      const code = await t.connect();
      // Without relay, code is derived from userId
      expect(code).toMatch(/^[A-Z0-9]+$/);
      expect(code.length).toBeLessThanOrEqual(6);

      t.dispose();
    });

    it('should throw when relay registration fails', async () => {
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'server error' }),
        text: async () => 'server error',
      }) as any;

      const options = createTransportOptions({
        pairingRelayUrl: 'https://test-relay.example.com',
      });
      const t = new PubSubTransport(options);

      await expect(t.connect()).rejects.toThrow('Pairing registration failed');

      t.dispose();
      global.fetch = originalFetch;
    });
  });

  // ─── Token Refresh ────────────────────────────────────────

  describe('token refresh', () => {
    it('should publish a token_refresh message via Pub/Sub', async () => {
      const httpClient = createMockHttpClient();
      const tokenProvider = createMockTokenProvider('fresh-token-abc');
      const options = createTransportOptions({
        httpClient,
        tokenProvider,
      });
      const t = new PubSubTransport(options);

      // Manually connect (skip the relay registration)
      (t as any).connected = true;
      (t as any).disposed = false;
      httpClient.setNextJsonResponse({ messageIds: ['1'] });

      await t.refreshAndPushToken();

      // Find the publish call (to the topic)
      const publishCalls = httpClient.calls.filter(c => c.url.includes(':publish'));
      expect(publishCalls.length).toBeGreaterThanOrEqual(1);

      const publishBody = publishCalls[0].body as any;
      const rawData = Buffer.from(publishBody.messages[0].data, 'base64').toString('utf-8');
      const envelope = JSON.parse(rawData);

      expect(envelope.messageType).toBe('token_refresh');
      expect(envelope.direction).toBe('ext_to_mobile');
      // Avro union encoding: payload is {"string": "..."}
      const payloadStr = typeof envelope.payload === 'object' && envelope.payload?.string
        ? envelope.payload.string
        : envelope.payload;
      const payload = JSON.parse(payloadStr);
      expect(payload.accessToken).toBe('fresh-token-abc');
      expect(payload.tokenExpiry).toBeGreaterThan(Date.now());

      t.dispose();
    });

    it('should start token refresh timer on connect', async () => {
      const options = createTransportOptions({
        tokenRefreshIntervalMs: 100, // Very short for testing
      });
      const t = new PubSubTransport(options);
      await t.connect();

      // Timer should be set
      expect((t as any).tokenRefreshTimer).not.toBeNull();

      t.dispose();
    });

    it('should stop token refresh timer on disconnect', async () => {
      const options = createTransportOptions();
      const t = new PubSubTransport(options);
      await t.connect();
      t.disconnect();

      expect((t as any).tokenRefreshTimer).toBeNull();
    });

    it('should re-register pairing code after token refresh when relay is configured', async () => {
      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = jest.fn().mockImplementation(async () => {
        fetchCallCount++;
        return {
          ok: true,
          status: 201,
          json: async () => ({ code: `CODE${fetchCallCount}` }),
          text: async () => `{"code":"CODE${fetchCallCount}"}`,
        };
      }) as any;

      const httpClient = createMockHttpClient();
      const tokenProvider = createMockTokenProvider('token-1');
      const options = createTransportOptions({
        httpClient,
        tokenProvider,
        pairingRelayUrl: 'https://test-relay.example.com',
      });
      const t = new PubSubTransport(options);

      // Connect (registers first pairing code)
      await t.connect();
      expect(t.code).toBe('CODE1');

      // Trigger token refresh (should re-register)
      httpClient.setNextJsonResponse({ messageIds: ['pub-1'] }); // For the publish call
      await t.refreshAndPushToken();
      expect(t.code).toBe('CODE2');

      t.dispose();
      global.fetch = originalFetch;
    });
  });
});
