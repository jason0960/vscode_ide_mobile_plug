import * as vscode from 'vscode';
import { BaseTunnel } from '@mobile-copilot/adapter-core';
import type { ILogger, IConfigProvider } from '@mobile-copilot/adapter-core';

/**
 * VS Code tunnel — extends BaseTunnel with vscode.env.asExternalUri support.
 */
export class VsCodeTunnel extends BaseTunnel {
  constructor(
    logger: ILogger,
    private readonly config: IConfigProvider,
  ) {
    super(logger);
  }

  /**
   * Start a tunnel based on the configured provider.
   */
  async startTunnel(port: number): Promise<string> {
    const provider = this.config.get<string>('tunnelProvider', 'none');

    switch (provider) {
      case 'vscode':
        return this.startVSCodeTunnel(port);
      case 'cloudflare':
        return this.startCloudflareTunnel(port);
      case 'ngrok':
        return this.startNgrokTunnel(port);
      default:
        throw new Error(`Unknown tunnel provider: ${provider}`);
    }
  }

  /**
   * VS Code built-in tunnel via vscode.env.asExternalUri.
   */
  private async startVSCodeTunnel(port: number): Promise<string> {
    try {
      const localUri = vscode.Uri.parse(`http://localhost:${port}`);
      const externalUri = await vscode.env.asExternalUri(localUri);
      this.tunnelUrl = externalUri.toString();
      this.logger.info(`[Tunnel] VS Code tunnel: ${this.tunnelUrl}`);
      return this.tunnelUrl;
    } catch (err: any) {
      const msg = `VS Code tunnel failed: ${err.message}`;
      this.logger.error(`[Tunnel] ${msg}`);
      vscode.window.showWarningMessage(
        `Mobile Copilot: ${msg}\n\nMake sure you're signed into GitHub and have "Remote - Tunnels" support.`
      );
      throw new Error(msg);
    }
  }

  /**
   * Toggle tunnel on/off.
   */
  async toggleTunnel(port: number): Promise<void> {
    if (this.isActive()) {
      await this.stopTunnel();
      vscode.window.showInformationMessage('Mobile Copilot: Tunnel stopped');
    } else {
      try {
        const url = await this.startTunnel(port);
        vscode.window.showInformationMessage(`Mobile Copilot: Tunnel active at ${url}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Mobile Copilot: Failed to start tunnel — ${err.message}`);
      }
    }
  }
}
