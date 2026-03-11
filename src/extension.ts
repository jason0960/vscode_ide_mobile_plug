import * as vscode from 'vscode';
import { MobileCopilotServer } from './server';
import { registerChatParticipant } from './participant';

let server: MobileCopilotServer | undefined;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Mobile Copilot', { log: true });
  outputChannel.info('Mobile Copilot extension activated');

  // Initialize server (does not start listening yet)
  server = new MobileCopilotServer(context, outputChannel);

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('mobile-copilot.start', async () => {
      try {
        await server!.start();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Mobile Copilot: ${err.message}`);
        outputChannel.error(err.message);
      }
    }),

    vscode.commands.registerCommand('mobile-copilot.stop', async () => {
      try {
        await server!.stop();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Mobile Copilot: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('mobile-copilot.showQR', async () => {
      if (!server!.getState().running) {
        const start = await vscode.window.showWarningMessage(
          'Server is not running. Start it first?',
          'Start Server'
        );
        if (start) {
          await vscode.commands.executeCommand('mobile-copilot.start');
        }
        return;
      }
      await server!.showQRCode();
    }),

    vscode.commands.registerCommand('mobile-copilot.toggleTunnel', async () => {
      if (!server!.getState().running) {
        vscode.window.showWarningMessage('Start the server first before enabling tunnel.');
        return;
      }
      await server!.toggleTunnel();
    }),

    vscode.commands.registerCommand('mobile-copilot.setTunnelUrl', async () => {
      if (!server!.getState().running) {
        vscode.window.showWarningMessage('Start the server first.');
        return;
      }
      const url = await vscode.window.showInputBox({
        prompt: 'Paste the forwarded URL from the Ports tab (e.g. https://xxxxx.devtunnels.ms)',
        placeHolder: 'https://...',
        validateInput: (v) => v && v.startsWith('https://') ? null : 'Must be an HTTPS URL',
      });
      if (url) {
        await server!.setTunnelUrl(url);
      }
    })
  );

  // Register @mobile chat participant (for direct use from VS Code Chat panel)
  registerChatParticipant(context, outputChannel);

  // Add server to subscriptions for cleanup
  context.subscriptions.push({ dispose: () => server?.dispose() });

  // Auto-start if configured
  const config = vscode.workspace.getConfiguration('mobileCopilot');
  if (config.get<boolean>('autoStart', false)) {
    vscode.commands.executeCommand('mobile-copilot.start');
  }

  outputChannel.info('Mobile Copilot ready. Run "Mobile Copilot: Start Server" to begin.');
}

export function deactivate() {
  server?.dispose();
  server = undefined;
}
