import * as vscode from 'vscode';
import { VsCodeServer } from './server';
import { VsCodeAuth } from './auth';
import { VsCodeTunnel } from './tunnel';
import { VsCodeConfig } from './config';
import { VsCodeLogger } from './logger';
import { registerChatParticipant } from './participant';

let server: VsCodeServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  const logger = new VsCodeLogger();
  const config = new VsCodeConfig();
  const auth = new VsCodeAuth(context, logger, config);
  const tunnel = new VsCodeTunnel(logger, config);

  server = new VsCodeServer(context, logger, auth, tunnel, config);

  context.subscriptions.push(
    vscode.commands.registerCommand('mobile-copilot.start', () => server!.start()),
    vscode.commands.registerCommand('mobile-copilot.stop', () => server!.stop()),
    vscode.commands.registerCommand('mobile-copilot.showQR', () => server!.showQRCode()),
    vscode.commands.registerCommand('mobile-copilot.toggleTunnel', () => server!.toggleTunnel()),
    vscode.commands.registerCommand('mobile-copilot.setTunnelUrl', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'Enter your tunnel URL (e.g. from VS Code Ports tab)',
        placeHolder: 'https://your-tunnel-url.example.com',
      });
      if (url) {
        await server!.setTunnelUrl(url);
      }
    }),
    vscode.commands.registerCommand('mobile-copilot.connectRelay', async () => {
      try {
        await server!.start(); // Ensure local server is running (needed for RPC handlers)
        const code = await server!.connectRelay();
        logger.info(`Relay connected. Room code: ${code}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Relay connection failed: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('mobile-copilot.disconnectRelay', () => {
      server!.disconnectRelay();
    }),
  );

  // Register the @mobile chat participant
  registerChatParticipant(context, logger.channel);

  // Auto-start if configured
  const autoStart = config.get<boolean>('autoStart', true);
  if (autoStart) {
    server.start().then(async () => {
      // Auto-connect to relay if a relay URL is configured
      const relayUrl = config.get<string>('relayUrl', '');
      if (relayUrl) {
        try {
          const code = await server!.connectRelay();
          logger.info(`Auto-connected to relay. Room code: ${code}`);
        } catch (err: any) {
          logger.error(`Auto relay connection failed: ${err.message}`);
        }
      }
    }).catch((err) => {
      logger.error(`Auto-start failed: ${err.message}`);
    });
  }

  logger.info('Mobile Copilot extension activated');
}

export function deactivate() {
  server?.dispose();
}
