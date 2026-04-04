import * as vscode from 'vscode';
import * as os from 'os';
import { VsCodeServer } from './server';
import { VsCodeAuth } from './auth';
import { VsCodeTunnel } from './tunnel';
import { VsCodeConfig } from './config';
import { VsCodeLogger } from './logger';
import { registerChatParticipant } from './participant';
import * as qrcode from 'qrcode';
import type { PubSubPairingInfo } from '@mobile-copilot/protocol';

const CLOUD_RELAY_URL = 'wss://gopilot-relay.onrender.com';

let server: VsCodeServer | undefined;

/**
 * Resolve the relay URL to use. Priority:
 * 1. User-configured external URL (mobileCopilot.relayUrl setting)
 * 2. Cloud relay (matches mobile app default)
 *
 * Only relevant when transportType is 'relay'. Pub/Sub ignores this.
 */
function getRelayUrl(config: VsCodeConfig): string | undefined {
  const transportType = config.get<string>('transportType', 'pubsub');
  if (transportType !== 'relay') return undefined; // Pub/Sub doesn't use relay URLs

  const externalUrl = config.get<string>('relayUrl', '');
  if (externalUrl) return externalUrl;
  return CLOUD_RELAY_URL;
}

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
        const relayUrl = getRelayUrl(config);
        const code = await server!.connectRelay(relayUrl);
        logger.info(`Transport connected. Pairing code: ${code}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Transport connection failed: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('mobile-copilot.disconnectRelay', () => {
      server!.disconnectRelay();
    }),
    vscode.commands.registerCommand('mobile-copilot.showExpoQR', async () => {
      await showExpoGoQR(config);
    }),
    vscode.commands.registerCommand('mobile-copilot.changeRoom', async () => {
      try {
        // Disconnect existing transport, then reconnect for a fresh pairing code
        server!.disconnectRelay();
        await new Promise(r => setTimeout(r, 500)); // Brief pause for clean disconnect

        const relayUrl = getRelayUrl(config);
        const code = await server!.connectRelay(relayUrl);
        logger.info(`Session changed. New pairing code: ${code}`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to change session: ${err.message}`);
      }
    }),
    vscode.commands.registerCommand('mobile-copilot.relayMenu', async () => {
      const transportType = config.get<string>('transportType', 'pubsub');
      const isPubSub = transportType === 'pubsub';
      const transportLabel = isPubSub ? 'Pub/Sub' : 'Relay';

      if (isPubSub) {
        // Pub/Sub mode — show pairing-centric menu
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(key) Show Pairing QR', description: 'Generate QR code for mobile to scan', id: 'pairing-qr' },
            { label: '$(clippy) Copy Pairing JSON', description: 'Copy pairing info to clipboard', id: 'pairing-copy' },
            { label: '$(refresh) Refresh Token', description: 'Regenerate pairing with fresh token', id: 'refresh' },
            { label: '$(debug-disconnect) Disconnect', description: 'Stop Pub/Sub transport', id: 'disconnect' },
          ] as (vscode.QuickPickItem & { id: string })[],
          { placeHolder: `${transportLabel} Session` },
        );
        if (!choice) return;
        switch ((choice as any).id) {
          case 'pairing-qr':
            await vscode.commands.executeCommand('mobile-copilot.showPairingInfo');
            break;
          case 'pairing-copy':
            await copyPubSubPairing(server!);
            break;
          case 'refresh':
            await vscode.commands.executeCommand('mobile-copilot.showPairingInfo');
            break;
          case 'disconnect':
            await vscode.commands.executeCommand('mobile-copilot.disconnectRelay');
            break;
        }
      } else {
        // Relay mode — original menu
        const code = server!.getRelayCode() || '???';
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(clippy) Copy Pairing Code', description: code, id: 'copy' },
            { label: '$(refresh) New Session', description: 'Get a new pairing code', id: 'change' },
            { label: '$(debug-disconnect) Disconnect', description: 'Stop Relay transport', id: 'disconnect' },
            { label: '$(qr-code) Show QR Code', description: 'LAN pairing QR', id: 'qr' },
          ] as (vscode.QuickPickItem & { id: string })[],
          { placeHolder: `Relay Session: ${code}` },
        );
        if (!choice) return;
        switch ((choice as any).id) {
          case 'copy':
            await vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage(`Pairing code copied: ${code}`);
            break;
          case 'change':
            await vscode.commands.executeCommand('mobile-copilot.changeRoom');
            break;
          case 'disconnect':
            await vscode.commands.executeCommand('mobile-copilot.disconnectRelay');
            break;
          case 'qr':
            await vscode.commands.executeCommand('mobile-copilot.showQR');
            break;
        }
      }
    }),
    vscode.commands.registerCommand('mobile-copilot.showPairingInfo', async () => {
      try {
        const pairing = await server!.getPairingInfo();
        if (!pairing) {
          vscode.window.showWarningMessage('Pairing info is only available in Pub/Sub transport mode.');
          return;
        }
        await showPubSubPairingQR(pairing);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to get pairing info: ${err.message}`);
      }
    }),
  );

  // Register the @mobile chat participant
  registerChatParticipant(context, logger.channel);

  // Auto-start if configured
  const autoStart = config.get<boolean>('autoStart', true);
  if (autoStart) {
    (async () => {
      try {
        // Start the extension server
        await server!.start();

        // Connect transport (relay or Pub/Sub based on config)
        const relayUrl = getRelayUrl(config);
        const transportType = config.get<string>('transportType', 'pubsub');
        try {
          const code = await server!.connectRelay(relayUrl);
          logger.info(`Auto-connected via ${transportType}. Pairing code: ${code}`);
        } catch (transportErr: any) {
          logger.error(`Transport connection failed (${transportType}): ${transportErr.message}`);
          // Server is still running, just no transport
        }
      } catch (err: any) {
        logger.error(`Auto-start failed: ${err.message}`);
        vscode.window.showErrorMessage(`AgentDeck auto-start failed: ${err.message}`);
      }
    })();
  }

  logger.info('AgentDeck extension activated');
}

/**
 * Get the machine's local network IP address.
 */
function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      // Skip internal (loopback) and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

/**
 * Copy Pub/Sub pairing info as JSON to the clipboard.
 */
async function copyPubSubPairing(srv: VsCodeServer): Promise<void> {
  const pairing = await srv.getPairingInfo();
  if (!pairing) {
    vscode.window.showWarningMessage('Pairing info not available — is Pub/Sub transport active?');
    return;
  }
  const json = JSON.stringify(pairing, null, 2);
  await vscode.env.clipboard.writeText(json);
  vscode.window.showInformationMessage('Pub/Sub pairing JSON copied to clipboard.');
}

/**
 * Show a webview panel with a QR code encoding the Pub/Sub pairing info.
 * The QR contains a JSON payload the mobile app can decode to auto-connect.
 */
async function showPubSubPairingQR(pairing: PubSubPairingInfo): Promise<void> {
  // Build compact pairing JSON for the QR payload
  const pairingJson = JSON.stringify(pairing);

  const qrDataUri = await qrcode.toDataURL(pairingJson, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'L', // Low correction — keeps QR small for large payloads
    color: { dark: '#ffffff', light: '#1e1e1e' },
  });

  const expiresAt = new Date(pairing.tokenExpiry).toLocaleTimeString();

  const panel = vscode.window.createWebviewPanel(
    'mobileCopilotPairingQR',
    'Pub/Sub Pairing — Scan to Connect',
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#1e1e1e; color:#ccc; }
    img { margin:20px 0; border-radius:12px; }
    h2 { color:#fff; margin-bottom:4px; }
    p { color:#aaa; font-size:14px; margin:4px 0; }
    .token-info { font-size:12px; color:#888; margin-top:12px; }
    .field { font-size:13px; color:#4fc1ff; font-family: 'Fira Code', 'Cascadia Code', monospace; margin:2px 0; }
    .steps { text-align:left; max-width:320px; margin-top:16px; font-size:13px; color:#999; line-height:1.6; }
    .steps li { margin-bottom:4px; }
  </style>
</head>
<body>
  <h2>🔗 Pub/Sub Pairing</h2>
  <p>Scan this QR code with the GoPilot mobile app</p>
  <img src="${qrDataUri}" width="320" height="320" />
  <p class="field">Project: ${pairing.projectId}</p>
  <p class="field">Topic: ${pairing.topicName}</p>
  <p class="field">User: ${pairing.userId}</p>
  <p class="token-info">Token expires at ${expiresAt}</p>
  <ol class="steps">
    <li>Open <strong>GoPilot</strong> on your phone</li>
    <li>Tap <strong>Connect via Pub/Sub</strong></li>
    <li>Scan this QR code</li>
  </ol>
</body>
</html>`;
}

/**
 * Show a QR code that opens the mobile app in Expo Go.
 * The URL format is exp://IP:PORT for dev, or a custom URL if provided.
 */
async function showExpoGoQR(config: VsCodeConfig): Promise<void> {
  const expoPort = config.get<number>('expoPort', 8081);
  const localIp = getLocalIp();

  // Build quick pick options — always offer tunnel as first option
  const options: Array<{ label: string; description: string; detail: string; url: string }> = [
    {
      label: '$(cloud) Tunnel (any network)',
      description: 'Creates a VS Code dev tunnel for port ' + expoPort,
      detail: 'Forwards Metro via devtunnels.ms — works from any network, no firewall config needed',
      url: '__tunnel__',
    },
    {
      label: `$(globe) LAN: exp://${localIp}:${expoPort}`,
      description: 'Same Wi-Fi network',
      detail: 'Requires phone and computer on the same network',
      url: `exp://${localIp}:${expoPort}`,
    },
    {
      label: `$(terminal) Localhost: exp://localhost:${expoPort}`,
      description: 'USB / emulator',
      detail: 'For Android emulator or USB-connected device',
      url: `exp://localhost:${expoPort}`,
    },
    {
      label: '$(pencil) Custom URL...',
      description: 'Enter a custom Expo URL',
      detail: 'Use any custom dev server URL',
      url: '__custom__',
    },
  ];

  const choice = await vscode.window.showQuickPick(
    options,
    { placeHolder: 'How should Expo Go connect to Metro?' },
  );

  if (!choice) return;

  let expoUrl = choice.url;

  // Handle tunnel — actively forward port and get public URL
  if (expoUrl === '__tunnel__') {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Creating dev tunnel for Metro...' },
        async () => {
          const localUri = vscode.Uri.parse(`http://localhost:${expoPort}`);
          const externalUri = await vscode.env.asExternalUri(localUri);
          const ext = externalUri.toString();
          if (!ext || ext.includes('localhost') || ext.includes('127.0.0.1')) {
            throw new Error('VS Code returned a local URL. Make sure you are signed into GitHub and have port forwarding enabled.');
          }
          const url = new URL(ext);
          expoUrl = `exp://${url.hostname}`;
        },
      );
    } catch (err: any) {
      // Offer to let user paste their own forwarded URL
      const forwarded = await vscode.window.showInputBox({
        prompt: `Tunnel failed: ${err.message}\n\nPaste the forwarded URL from the Ports tab (or use "Forward a Port" → 8081 → Public)`,
        placeHolder: 'https://xxxxx-8081.usw2.devtunnels.ms',
      });
      if (!forwarded) return;
      try {
        const url = new URL(forwarded);
        expoUrl = `exp://${url.hostname}`;
      } catch {
        expoUrl = forwarded.replace(/^https?:\/\//, 'exp://');
      }
    }
  }

  if (expoUrl === '__custom__') {
    const input = await vscode.window.showInputBox({
      prompt: 'Enter the full Expo URL',
      placeHolder: 'exp://your-url.devtunnels.ms',
      value: `exp://${localIp}:${expoPort}`,
    });
    if (!input) return;
    expoUrl = input;
  }

  // Generate QR code
  const qrDataUri = await qrcode.toDataURL(expoUrl, {
    width: 280,
    margin: 2,
    color: { dark: '#ffffff', light: '#1e1e1e' },
  });

  const panel = vscode.window.createWebviewPanel(
    'mobileCopilotExpoQR',
    'Expo Go — Scan to Open',
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body { display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#1e1e1e; color:#ccc; }
    img { margin:20px 0; border-radius:12px; }
    .url { font-size:13px; color:#4fc1ff; word-break:break-all; max-width:320px; text-align:center; margin-top:8px; font-family: 'Fira Code', 'Cascadia Code', monospace; }
    h2 { color:#fff; margin-bottom:0; }
    p { color:#aaa; font-size:14px; }
    .steps { text-align:left; max-width:300px; margin-top:16px; font-size:13px; color:#999; line-height:1.6; }
    .steps li { margin-bottom:4px; }
  </style>
</head>
<body>
  <h2>📱 Open in Expo Go</h2>
  <p>Scan this QR code with the Expo Go app</p>
  <img src="${qrDataUri}" width="280" height="280" />
  <p class="url">${expoUrl}</p>
  <ol class="steps">
    <li>Install <strong>Expo Go</strong> from App Store / Play Store</li>
    <li>Open Expo Go and tap <strong>Scan QR Code</strong></li>
    <li>Point your camera at this code</li>
  </ol>
</body>
</html>`;
}

export async function deactivate() {
  server?.dispose();
}
