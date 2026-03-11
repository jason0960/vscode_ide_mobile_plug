import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Session } from './types';

/**
 * Authentication module — handles QR code pairing, token generation,
 * session management, and WebSocket connection validation.
 */
export class AuthManager {
  private token: string = '';
  private sessions: Map<string, Session> = new Map();
  private secretStorage: vscode.SecretStorage;
  private sessionTimeoutSec: number;

  constructor(context: vscode.ExtensionContext) {
    this.secretStorage = context.secrets;
    this.sessionTimeoutSec = vscode.workspace
      .getConfiguration('mobileCopilot')
      .get<number>('sessionTimeout', 3600);
  }

  /**
   * Generate a new auth token and persist it in SecretStorage.
   */
  async generateToken(): Promise<string> {
    this.token = crypto.randomBytes(32).toString('hex');
    await this.secretStorage.store('mobile-copilot-token', this.token);
    return this.token;
  }

  /**
   * Retrieve the current token (or generate a new one).
   */
  async getToken(): Promise<string> {
    if (!this.token) {
      const stored = await this.secretStorage.get('mobile-copilot-token');
      if (stored) {
        this.token = stored;
      } else {
        await this.generateToken();
      }
    }
    return this.token;
  }

  /**
   * Validate an incoming token against the stored token.
   */
  async validateToken(incoming: string): Promise<boolean> {
    const valid = await this.getToken();
    return crypto.timingSafeEqual(
      Buffer.from(incoming, 'hex'),
      Buffer.from(valid, 'hex')
    );
  }

  /**
   * Create a new session after successful auth.
   */
  createSession(userAgent?: string): Session {
    const session: Session = {
      id: crypto.randomUUID(),
      token: this.token,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      userAgent,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Validate a session ID and update its last activity time.
   */
  validateSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (this.sessionTimeoutSec > 0) {
      const elapsed = (Date.now() - session.lastActivity) / 1000;
      if (elapsed > this.sessionTimeoutSec) {
        this.sessions.delete(sessionId);
        return false;
      }
    }

    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Remove a session.
   */
  removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Get count of active sessions.
   */
  getActiveSessionCount(): number {
    this.pruneExpiredSessions();
    return this.sessions.size;
  }

  /**
   * Remove all expired sessions.
   */
  private pruneExpiredSessions(): void {
    if (this.sessionTimeoutSec <= 0) return;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if ((now - session.lastActivity) / 1000 > this.sessionTimeoutSec) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Generate a QR code pairing URL.
   */
  getPairingUrl(baseUrl: string): string {
    return `${baseUrl}/pair?token=${this.token}`;
  }

  /**
   * Generate QR code as a data URI using the qrcode library.
   */
  async generateQRDataUri(url: string): Promise<string> {
    const QRCode = require('qrcode');
    return QRCode.toDataURL(url, {
      width: 280,
      margin: 2,
      color: {
        dark: '#ffffff',
        light: '#1e1e1e',
      },
    });
  }

  /**
   * Show the QR code in a VS Code Webview panel.
   */
  async showQRPanel(
    context: vscode.ExtensionContext,
    pairingUrl: string,
    serverUrl: string
  ): Promise<vscode.WebviewPanel> {
    const qrDataUri = await this.generateQRDataUri(pairingUrl);

    const panel = vscode.window.createWebviewPanel(
      'mobileCopilotQR',
      'Mobile Copilot — Pair Device',
      vscode.ViewColumn.One,
      { enableScripts: false }
    );

    panel.webview.html = this.getQRHtml(qrDataUri, pairingUrl, serverUrl);
    return panel;
  }

  private getQRHtml(qrDataUri: string, pairingUrl: string, serverUrl: string): string {
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mobile Copilot Pairing</title>
  <style>
    body {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #1e1e1e;
      color: #cccccc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    .container {
      text-align: center;
      max-width: 400px;
      padding: 2rem;
    }
    h1 {
      color: #ffffff;
      font-size: 1.5rem;
      margin-bottom: 0.5rem;
    }
    .subtitle {
      color: #888;
      font-size: 0.9rem;
      margin-bottom: 2rem;
    }
    .qr-container {
      background: #1e1e1e;
      border-radius: 16px;
      padding: 1rem;
      display: inline-block;
      margin-bottom: 1.5rem;
      box-shadow: 0 4px 24px rgba(0,0,0,0.3);
    }
    .qr-container img {
      display: block;
      width: 280px;
      height: 280px;
    }
    .url-box {
      background: #2d2d2d;
      border: 1px solid #404040;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-family: 'Cascadia Code', 'Fira Code', monospace;
      font-size: 0.8rem;
      word-break: break-all;
      color: #4fc1ff;
      margin-bottom: 1rem;
    }
    .instructions {
      font-size: 0.85rem;
      color: #999;
      line-height: 1.6;
    }
    .instructions ol {
      text-align: left;
      padding-left: 1.2rem;
    }
    .instructions li {
      margin-bottom: 0.5rem;
    }
    .status {
      margin-top: 1.5rem;
      padding: 0.5rem 1rem;
      border-radius: 20px;
      font-size: 0.8rem;
      background: #1a3a1a;
      color: #4ec94e;
      display: inline-block;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>📱 Mobile Copilot</h1>
    <p class="subtitle">Scan to connect your mobile device</p>

    <div class="qr-container">
      <img src="${qrDataUri}" alt="QR Code" />
    </div>

    <div class="url-box">${serverUrl}</div>

    <div class="instructions">
      <ol>
        <li>Open your phone's camera or a QR scanner</li>
        <li>Scan the QR code above</li>
        <li>The Mobile Copilot app will open in your browser</li>
        <li>You're connected! Start chatting with Copilot</li>
      </ol>
    </div>

    <div class="status">● Server running on port ${new URL(serverUrl).port || '80'}</div>
  </div>
</body>
</html>`;
  }

  /**
   * Clear all sessions and reset token.
   */
  async reset(): Promise<void> {
    this.sessions.clear();
    this.token = '';
    await this.secretStorage.delete('mobile-copilot-token');
  }
}
