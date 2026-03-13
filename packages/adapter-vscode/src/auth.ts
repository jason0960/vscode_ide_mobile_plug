import * as vscode from 'vscode';
import { BaseAuth } from '@mobile-copilot/adapter-core';
import type { ILogger, ISecretStore, IConfigProvider } from '@mobile-copilot/adapter-core';

/**
 * VS Code secret storage adapter.
 */
class VsCodeSecretStore implements ISecretStore {
  constructor(private secrets: vscode.SecretStorage) {}

  async get(key: string): Promise<string | undefined> {
    return this.secrets.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    await this.secrets.store(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.secrets.delete(key);
  }
}

/**
 * VS Code auth — extends BaseAuth with webview QR panel.
 */
export class VsCodeAuth extends BaseAuth {
  private extensionContext: vscode.ExtensionContext;

  constructor(
    context: vscode.ExtensionContext,
    logger: ILogger,
    config: IConfigProvider,
  ) {
    super(logger, new VsCodeSecretStore(context.secrets), config);
    this.extensionContext = context;
  }

  async showQRPanel(serverUrl: string): Promise<void> {
    const qrDataUri = await this.generateQRDataUri(serverUrl);
    const pairingUrl = this.getPairingUrl(serverUrl);

    const panel = vscode.window.createWebviewPanel(
      'mobileCopilotQR',
      'Mobile Copilot — Pair',
      vscode.ViewColumn.Beside,
      { enableScripts: false },
    );

    panel.webview.html = this.getQRHtml(qrDataUri, pairingUrl);

    // Auto-close after 5 minutes (token expiry)
    setTimeout(() => {
      panel.dispose();
    }, 5 * 60 * 1000);
  }
}
