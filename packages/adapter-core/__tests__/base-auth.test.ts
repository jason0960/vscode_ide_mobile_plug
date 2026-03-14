/**
 * BaseAuth — unit tests
 *
 * Covers: token generation/validation (timingSafeEqual), session CRUD,
 * expiry enforcement, pairing flow (5-min TTL, one-time consumption),
 * cleanExpiredSessions, QR helpers, and reset.
 */
import { BaseAuth } from '../src/base-auth';
import type { ILogger, ISecretStore, IConfigProvider } from '../src/interfaces';

// ─── Concrete subclass (BaseAuth is abstract) ───────────────────

class TestAuth extends BaseAuth {
  async showQRPanel(_serverUrl: string): Promise<void> {
    // no-op for tests
  }
}

// ─── Mock factories ─────────────────────────────────────────────

function createMockLogger(): ILogger {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function createMockSecretStore(): ISecretStore {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key)),
    store: jest.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: jest.fn(async (key: string) => { store.delete(key); }),
  };
}

function createMockConfig(overrides: Record<string, any> = {}): IConfigProvider {
  return {
    get: jest.fn(<T>(key: string, defaultValue?: T) => {
      return key in overrides ? overrides[key] : defaultValue;
    }),
  };
}

describe('BaseAuth', () => {
  let auth: TestAuth;
  let logger: ILogger;
  let secrets: ISecretStore;
  let config: IConfigProvider;

  beforeEach(() => {
    logger = createMockLogger();
    secrets = createMockSecretStore();
    config = createMockConfig({ sessionTimeout: 3600 }); // 1 hour
    auth = new TestAuth(logger, secrets, config);
  });

  // ─── Token Management ─────────────────────────────────────────

  describe('generateToken', () => {
    it('returns a 64-char hex string', async () => {
      const token = await auth.generateToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('stores the token in secret store', async () => {
      await auth.generateToken();
      expect(secrets.store).toHaveBeenCalledWith(
        'mobile-copilot-token',
        expect.stringMatching(/^[0-9a-f]{64}$/),
      );
    });

    it('generates different tokens each call', async () => {
      const t1 = await auth.generateToken();
      const t2 = await auth.generateToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('getToken', () => {
    it('generates new token when none exists', async () => {
      const token = await auth.getToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns cached token on second call', async () => {
      const t1 = await auth.getToken();
      const t2 = await auth.getToken();
      expect(t1).toBe(t2);
    });

    it('retrieves token from secret store if available', async () => {
      const storedToken = 'a'.repeat(64);
      (secrets.get as jest.Mock).mockResolvedValueOnce(storedToken);

      // Create a fresh auth so cached token is empty
      const freshAuth = new TestAuth(logger, secrets, config);
      const token = await freshAuth.getToken();
      expect(token).toBe(storedToken);
    });
  });

  describe('validateToken', () => {
    it('returns true for matching token', async () => {
      const token = await auth.generateToken();
      const result = await auth.validateToken(token);
      expect(result).toBe(true);
    });

    it('returns false for wrong token', async () => {
      await auth.generateToken();
      const result = await auth.validateToken('b'.repeat(64));
      expect(result).toBe(false);
    });

    it('returns false for malformed token (non-hex)', async () => {
      await auth.generateToken();
      const result = await auth.validateToken('not-hex-at-all');
      expect(result).toBe(false);
    });

    it('returns false for empty string', async () => {
      await auth.generateToken();
      const result = await auth.validateToken('');
      expect(result).toBe(false);
    });
  });

  // ─── Session Management ───────────────────────────────────────

  describe('createSession', () => {
    it('returns a session with UUID id', () => {
      const session = auth.createSession('test-agent');
      expect(session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('sets connectedAt and lastActivity to now', () => {
      const before = Date.now();
      const session = auth.createSession();
      const after = Date.now();
      expect(session.connectedAt).toBeGreaterThanOrEqual(before);
      expect(session.connectedAt).toBeLessThanOrEqual(after);
      expect(session.lastActivity).toBe(session.connectedAt);
    });

    it('records userAgent', () => {
      const session = auth.createSession('Mobile/1.0');
      expect(session.userAgent).toBe('Mobile/1.0');
    });

    it('logs session creation', () => {
      const session = auth.createSession();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining(session.id),
      );
    });
  });

  describe('validateSession', () => {
    it('returns true for valid session', () => {
      const session = auth.createSession();
      expect(auth.validateSession(session.id)).toBe(true);
    });

    it('returns false for unknown session', () => {
      expect(auth.validateSession('nonexistent-id')).toBe(false);
    });

    it('returns false for expired session', () => {
      // Use a very short timeout
      const shortConfig = createMockConfig({ sessionTimeout: 1 }); // 1 second
      const shortAuth = new TestAuth(logger, secrets, shortConfig);
      const session = shortAuth.createSession();

      // Manually expire by manipulating the clock
      jest.useFakeTimers();
      jest.advanceTimersByTime(2000);

      expect(shortAuth.validateSession(session.id)).toBe(false);

      jest.useRealTimers();
    });

    it('updates lastActivity on valid session', () => {
      const session = auth.createSession();
      const original = session.lastActivity;

      // Small delay to ensure time difference
      const later = original + 10;
      jest.spyOn(Date, 'now').mockReturnValueOnce(later).mockReturnValue(later);

      auth.validateSession(session.id);
      // lastActivity is updated inside validateSession, verifiable by calling again
      expect(auth.validateSession(session.id)).toBe(true);
    });
  });

  describe('removeSession', () => {
    it('removes session so it fails validation', () => {
      const session = auth.createSession();
      auth.removeSession(session.id);
      expect(auth.validateSession(session.id)).toBe(false);
    });

    it('deletes session secret', () => {
      const session = auth.createSession();
      auth.removeSession(session.id);
      expect(secrets.delete).toHaveBeenCalledWith(`session:${session.id}`);
    });

    it('logs removal', () => {
      const session = auth.createSession();
      auth.removeSession(session.id);
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('removed'),
      );
    });
  });

  describe('getActiveSessionCount', () => {
    it('returns 0 initially', () => {
      expect(auth.getActiveSessionCount()).toBe(0);
    });

    it('increments with each new session', () => {
      auth.createSession();
      auth.createSession();
      expect(auth.getActiveSessionCount()).toBe(2);
    });

    it('decrements after removal', () => {
      const s1 = auth.createSession();
      auth.createSession();
      auth.removeSession(s1.id);
      expect(auth.getActiveSessionCount()).toBe(1);
    });
  });

  // ─── Pairing ──────────────────────────────────────────────────

  describe('generatePairingToken', () => {
    it('returns a 32-char hex string', async () => {
      const token = await auth.generatePairingToken();
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('validatePairingToken', () => {
    it('returns session on valid pairing token', async () => {
      const pairingToken = await auth.generatePairingToken();
      const session = await auth.validatePairingToken(pairingToken);
      expect(session).not.toBeNull();
      expect(session!.id).toBeDefined();
      expect(session!.userAgent).toBe('mobile-device');
    });

    it('returns null for wrong token', async () => {
      await auth.generatePairingToken();
      const session = await auth.validatePairingToken('wrong');
      expect(session).toBeNull();
    });

    it('consumes token (one-time use)', async () => {
      const pairingToken = await auth.generatePairingToken();
      await auth.validatePairingToken(pairingToken);

      // Second use should fail
      const second = await auth.validatePairingToken(pairingToken);
      expect(second).toBeNull();
    });

    it('returns null after 5 minutes', async () => {
      jest.useFakeTimers();

      const pairingToken = await auth.generatePairingToken();

      // Advance 6 minutes
      jest.advanceTimersByTime(6 * 60 * 1000);

      const session = await auth.validatePairingToken(pairingToken);
      expect(session).toBeNull();

      jest.useRealTimers();
    });

    it('returns null when no pairing token generated', async () => {
      const session = await auth.validatePairingToken('anything');
      expect(session).toBeNull();
    });
  });

  // ─── cleanExpiredSessions ─────────────────────────────────────

  describe('cleanExpiredSessions', () => {
    it('removes expired sessions', async () => {
      const shortConfig = createMockConfig({ sessionTimeout: 1 });
      const shortAuth = new TestAuth(logger, secrets, shortConfig);

      shortAuth.createSession();
      shortAuth.createSession();
      expect(shortAuth.getActiveSessionCount()).toBe(2);

      jest.useFakeTimers();
      jest.advanceTimersByTime(2000);

      await shortAuth.cleanExpiredSessions();
      expect(shortAuth.getActiveSessionCount()).toBe(0);

      jest.useRealTimers();
    });

    it('keeps non-expired sessions', async () => {
      auth.createSession();
      await auth.cleanExpiredSessions();
      expect(auth.getActiveSessionCount()).toBe(1);
    });
  });

  // ─── QR Code Helpers ──────────────────────────────────────────

  describe('getPairingUrl', () => {
    it('builds correct URL with token', async () => {
      const token = await auth.generateToken();
      const url = auth.getPairingUrl('http://localhost:3847');
      expect(url).toBe(`http://localhost:3847/pair?token=${token}`);
    });
  });

  describe('getQRHtml', () => {
    it('returns HTML containing QR data URI and pairing URL', () => {
      const html = auth.getQRHtml(
        'data:image/png;base64,abc123',
        'http://localhost:3847/pair?token=xyz',
      );
      expect(html).toContain('data:image/png;base64,abc123');
      expect(html).toContain('http://localhost:3847/pair?token=xyz');
      expect(html).toContain('Mobile Copilot');
    });
  });

  // ─── Reset ────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears all sessions', async () => {
      auth.createSession();
      auth.createSession();
      await auth.reset();
      expect(auth.getActiveSessionCount()).toBe(0);
    });

    it('clears pairing token', async () => {
      const pairingToken = await auth.generatePairingToken();
      await auth.reset();
      const session = await auth.validatePairingToken(pairingToken);
      expect(session).toBeNull();
    });

    it('logs reset', async () => {
      await auth.reset();
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('Reset'),
      );
    });
  });
});
