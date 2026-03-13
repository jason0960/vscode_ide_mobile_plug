import * as crypto from 'crypto';
import type { Session } from '@mobile-copilot/protocol';
import type { ILogger, ISecretStore, IConfigProvider } from './interfaces';

const qrcode = require('qrcode');

interface SessionData {
  session: Session;
  expiresAt: number;
}

/**
 * Portable authentication manager — session CRUD, QR generation, token handling.
 *
 * IDE-specific behaviour (e.g. showing a webview QR panel) is implemented
 * by subclasses.
 */
export abstract class BaseAuth {
  protected sessions: Map<string, SessionData> = new Map();
  protected pairingToken: string | null = null;
  protected pairingExpiry: number = 0;
  /** Persistent auth token — generated on server start, used for QR pairing. */
  protected token: string = '';

  constructor(
    protected readonly logger: ILogger,
    protected readonly secrets: ISecretStore,
    protected readonly config: IConfigProvider,
  ) {}

  // ─── Persistent Token (for QR pairing) ───────────────────────

  /** Generate a new persistent auth token and store it in secrets. */
  async generateToken(): Promise<string> {
    this.token = crypto.randomBytes(32).toString('hex');
    await this.secrets.store('mobile-copilot-token', this.token);
    return this.token;
  }

  /** Get the current token, or generate one if missing. */
  async getToken(): Promise<string> {
    if (!this.token) {
      const stored = await this.secrets.get('mobile-copilot-token');
      if (stored) {
        this.token = stored;
      } else {
        await this.generateToken();
      }
    }
    return this.token;
  }

  /** Validate an incoming token against the stored token. */
  async validateToken(incoming: string): Promise<boolean> {
    const valid = await this.getToken();
    try {
      return crypto.timingSafeEqual(
        Buffer.from(incoming, 'hex'),
        Buffer.from(valid, 'hex'),
      );
    } catch {
      return false;
    }
  }

  // ─── Session Management (portable) ───────────────────────────

  createSession(userAgent?: string): Session {
    const sessionId = crypto.randomUUID();

    const session: Session = {
      id: sessionId,
      token: this.token,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      userAgent,
    };

    const timeout = this.config.get<number>('sessionTimeout', 3600);
    const expiresAt = timeout > 0 ? Date.now() + timeout * 1000 : Infinity;

    this.sessions.set(sessionId, { session, expiresAt });
    this.logger.info(`[Auth] Session created: ${sessionId}`);
    return session;
  }

  /**
   * Validate a session ID — just checks it exists and hasn't expired.
   * Token is NOT required for reconnection (mobile sends only sessionId).
   */
  validateSession(sessionId: string): boolean {
    const data = this.sessions.get(sessionId);
    if (!data) return false;

    if (data.expiresAt < Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }

    data.session.lastActivity = Date.now();
    return true;
  }

  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.secrets.delete(`session:${sessionId}`).catch(() => {});
    this.logger.info(`[Auth] Session removed: ${sessionId}`);
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  // ─── Pairing ─────────────────────────────────────────────────

  async generatePairingToken(): Promise<string> {
    this.pairingToken = crypto.randomBytes(16).toString('hex');
    this.pairingExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
    return this.pairingToken;
  }

  async validatePairingToken(token: string): Promise<Session | null> {
    if (!this.pairingToken || token !== this.pairingToken) return null;
    if (Date.now() > this.pairingExpiry) {
      this.pairingToken = null;
      return null;
    }

    // Consume the token (one-time use)
    this.pairingToken = null;

    return this.createSession('mobile-device');
  }

  async cleanExpiredSessions(): Promise<void> {
    const now = Date.now();
    for (const [id, data] of this.sessions) {
      if (data.expiresAt < now) {
        this.sessions.delete(id);
        await this.secrets.delete(`session:${id}`).catch(() => {});
      }
    }
  }

  // ─── QR Code Generation (portable) ───────────────────────────

  /** Build a pairing URL using the persistent token. */
  getPairingUrl(serverUrl: string): string {
    return `${serverUrl}/pair?token=${this.token}`;
  }

  async generateQRDataUri(serverUrl: string): Promise<string> {
    const url = this.getPairingUrl(serverUrl);
    return qrcode.toDataURL(url, {
      width: 280,
      margin: 2,
      color: { dark: '#ffffff', light: '#1e1e1e' },
    });
  }

  getQRHtml(qrDataUri: string, pairingUrl: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#1e1e1e; color:#ccc; }
    img { margin:20px 0; border-radius:12px; }
    .url { font-size:12px; color:#888; word-break:break-all; max-width:300px; text-align:center; margin-top:10px; }
    h2 { color:#fff; margin-bottom:0; }
    p { color:#aaa; font-size:14px; }
  </style>
</head>
<body>
  <h2>📱 Mobile Copilot</h2>
  <p>Scan this QR code with your phone</p>
  <img src="${qrDataUri}" width="280" height="280" />
  <p class="url">${pairingUrl}</p>
  <p style="font-size:12px; color:#666; margin-top:20px;">Token expires in 5 minutes</p>
</body>
</html>`;
  }

  // ─── Abstract — IDE subclass must implement ──────────────────

  /** Show the QR pairing UI (webview panel, dialog, etc.) */
  abstract showQRPanel(serverUrl: string): Promise<void>;

  // ─── Reset ───────────────────────────────────────────────────

  async reset(): Promise<void> {
    for (const [id] of this.sessions) {
      await this.secrets.delete(`session:${id}`).catch(() => {});
    }
    this.sessions.clear();
    this.pairingToken = null;
    this.logger.info('[Auth] Reset all sessions');
  }
}
