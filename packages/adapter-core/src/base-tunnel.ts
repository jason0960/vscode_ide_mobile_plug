import { ChildProcess, spawn } from 'child_process';
import type { ILogger, IConfigProvider } from './interfaces';

/**
 * Portable tunnel management — Cloudflare and ngrok tunnels.
 *
 * IDE-specific tunnels (e.g. vscode.env.asExternalUri) are added
 * by subclasses.
 */
export class BaseTunnel {
  protected tunnelUrl: string | null = null;
  protected tunnelProcess: ChildProcess | null = null;

  constructor(
    protected readonly logger: ILogger,
  ) {}

  // ─── Cloudflare Quick Tunnel ─────────────────────────────────

  async startCloudflareTunnel(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.tunnelProcess = proc;

      const onData = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match) {
          this.tunnelUrl = match[0];
          this.logger.info(`[Tunnel] Cloudflare tunnel: ${this.tunnelUrl}`);
          resolve(this.tunnelUrl);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        reject(new Error(`Failed to start cloudflared: ${err.message}. Is cloudflared installed?`));
      });

      proc.on('exit', (code) => {
        if (!this.tunnelUrl) {
          reject(new Error(`cloudflared exited with code ${code} before establishing tunnel`));
        }
        this.tunnelProcess = null;
      });

      // Timeout
      setTimeout(() => {
        if (!this.tunnelUrl) {
          this.stopTunnel();
          reject(new Error('Cloudflare tunnel timed out (30s)'));
        }
      }, 30_000);
    });
  }

  // ─── ngrok Tunnel ────────────────────────────────────────────

  async startNgrokTunnel(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('ngrok', ['http', String(port), '--log=stdout'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.tunnelProcess = proc;

      const onData = (data: Buffer) => {
        const output = data.toString();
        const match = output.match(/url=(https:\/\/[^\s]+)/);
        if (match) {
          this.tunnelUrl = match[1];
          this.logger.info(`[Tunnel] ngrok tunnel: ${this.tunnelUrl}`);
          resolve(this.tunnelUrl);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('error', (err) => {
        reject(new Error(`Failed to start ngrok: ${err.message}. Is ngrok installed?`));
      });

      proc.on('exit', (code) => {
        if (!this.tunnelUrl) {
          reject(new Error(`ngrok exited with code ${code} before establishing tunnel`));
        }
        this.tunnelProcess = null;
      });

      setTimeout(() => {
        if (!this.tunnelUrl) {
          this.stopTunnel();
          reject(new Error('ngrok tunnel timed out (30s)'));
        }
      }, 30_000);
    });
  }

  // ─── Manual URL ──────────────────────────────────────────────

  setManualUrl(url: string): void {
    this.tunnelUrl = url;
    this.logger.info(`[Tunnel] Manual URL set: ${url}`);
  }

  // ─── Lifecycle ───────────────────────────────────────────────

  async stopTunnel(): Promise<void> {
    if (this.tunnelProcess) {
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.tunnelUrl = null;
    this.logger.info('[Tunnel] Stopped');
  }

  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  isActive(): boolean {
    return this.tunnelUrl !== null;
  }

  dispose(): void {
    this.stopTunnel().catch(() => {});
  }
}
