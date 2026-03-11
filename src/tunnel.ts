import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

/**
 * Tunnel support — exposes the local server to the internet.
 * Supports VS Code dev tunnels, Cloudflare Tunnel, and ngrok.
 */
export class TunnelManager {
  private tunnelProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private outputChannel: vscode.LogOutputChannel;
  private disposables: vscode.Disposable[] = [];

  constructor(outputChannel: vscode.LogOutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Get the current tunnel URL (null if no tunnel active).
   */
  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  /**
   * Manually set a tunnel URL (e.g. from VS Code Ports tab).
   */
  setManualUrl(url: string): void {
    this.tunnelUrl = url;
    this.outputChannel.info(`Manual tunnel URL set: ${url}`);
  }

  /**
   * Start a tunnel based on the configured provider.
   */
  async startTunnel(localPort: number): Promise<string | null> {
    const config = vscode.workspace.getConfiguration('mobileCopilot');
    const provider = config.get<string>('tunnelProvider', 'none');

    switch (provider) {
      case 'vscode':
        return this.startVSCodeTunnel(localPort);
      case 'cloudflare':
        return this.startCloudflareTunnel(localPort);
      case 'ngrok':
        return this.startNgrokTunnel(localPort);
      case 'none':
      default:
        return null;
    }
  }

  /**
   * Use VS Code's built-in port forwarding.
   */
  private async startVSCodeTunnel(localPort: number): Promise<string | null> {
    try {
      const localUri = vscode.Uri.parse(`http://localhost:${localPort}`);
      const externalUri = await vscode.env.asExternalUri(localUri);
      const externalUrl = externalUri.toString().replace(/\/$/, '');

      // Check if VS Code actually returned a tunnel URL (not just localhost)
      if (externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1')) {
        this.outputChannel.warn(
          `VS Code returned local URL: ${externalUrl}. ` +
          `Make sure Remote Tunnels extension is installed and you're signed into GitHub. ` +
          `Or manually forward port ${localPort} in the Ports tab and copy the forwarded URL.`
        );
        // Show guidance to the user
        const action = await vscode.window.showWarningMessage(
          `VS Code tunnel returned localhost. Port forwarding may not be active. ` +
          `Check the Ports tab — if port ${localPort} is forwarded, copy its URL.`,
          'Open Ports Tab',
          'Use Local URL'
        );
        if (action === 'Open Ports Tab') {
          await vscode.commands.executeCommand('workbench.panel.ports.focus');
        }
        // Still return null so we fall back to LAN URL
        return null;
      }

      this.tunnelUrl = externalUrl;
      this.outputChannel.info(`VS Code tunnel active: ${this.tunnelUrl}`);
      return this.tunnelUrl;
    } catch (err: any) {
      this.outputChannel.error(`VS Code tunnel failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Start a Cloudflare Tunnel (requires `cloudflared` installed).
   */
  private async startCloudflareTunnel(localPort: number): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        this.tunnelProcess = spawn('cloudflared', [
          'tunnel', '--url', `http://localhost:${localPort}`,
        ]);

        let resolved = false;

        this.tunnelProcess.stderr?.on('data', (data: Buffer) => {
          const output = data.toString();
          this.outputChannel.trace(`[cloudflared] ${output}`);

          // Cloudflare prints the tunnel URL to stderr
          const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match && !resolved) {
            resolved = true;
            this.tunnelUrl = match[0];
            this.outputChannel.info(`Cloudflare tunnel active: ${this.tunnelUrl}`);
            resolve(this.tunnelUrl);
          }
        });

        this.tunnelProcess.on('error', (err) => {
          this.outputChannel.error(`cloudflared error: ${err.message}`);
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        this.tunnelProcess.on('exit', (code) => {
          this.outputChannel.info(`cloudflared exited with code ${code}`);
          this.tunnelUrl = null;
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        // Timeout after 15 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.outputChannel.warn('Cloudflare tunnel timed out');
            resolve(null);
          }
        }, 15000);
      } catch (err: any) {
        this.outputChannel.error(`Failed to start cloudflared: ${err.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Start an ngrok tunnel (requires `ngrok` installed + authed).
   */
  private async startNgrokTunnel(localPort: number): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        this.tunnelProcess = spawn('ngrok', ['http', String(localPort), '--log=stdout']);

        let resolved = false;

        this.tunnelProcess.stdout?.on('data', (data: Buffer) => {
          const output = data.toString();
          this.outputChannel.trace(`[ngrok] ${output}`);

          const match = output.match(/url=(https:\/\/[^\s]+)/);
          if (match && !resolved) {
            resolved = true;
            this.tunnelUrl = match[1];
            this.outputChannel.info(`ngrok tunnel active: ${this.tunnelUrl}`);
            resolve(this.tunnelUrl);
          }
        });

        this.tunnelProcess.on('error', (err) => {
          this.outputChannel.error(`ngrok error: ${err.message}`);
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        this.tunnelProcess.on('exit', (code) => {
          this.outputChannel.info(`ngrok exited with code ${code}`);
          this.tunnelUrl = null;
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            this.outputChannel.warn('ngrok tunnel timed out');
            resolve(null);
          }
        }, 15000);
      } catch (err: any) {
        this.outputChannel.error(`Failed to start ngrok: ${err.message}`);
        resolve(null);
      }
    });
  }

  /**
   * Stop any active tunnel.
   */
  stopTunnel(): void {
    if (this.tunnelProcess) {
      this.tunnelProcess.kill('SIGTERM');
      this.tunnelProcess = null;
    }
    this.tunnelUrl = null;
    this.outputChannel.info('Tunnel stopped');
  }

  /**
   * Check if a tunnel is currently active.
   */
  isActive(): boolean {
    return this.tunnelUrl !== null;
  }

  dispose(): void {
    this.stopTunnel();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
