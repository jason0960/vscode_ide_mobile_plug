/**
 * Extension activation tests — verifies transport-agnostic command wiring,
 * auto-start behavior, and getRelayUrl resolution logic.
 */

// ── Hoist mocks before any imports ────────────────────────────────
const mockServer = {
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn(),
  showQRCode: jest.fn(),
  toggleTunnel: jest.fn(),
  setTunnelUrl: jest.fn(),
  connectRelay: jest.fn().mockResolvedValue('ABC123'),
  disconnectRelay: jest.fn(),
  getRelayCode: jest.fn().mockReturnValue('ABC123'),
  getPairingInfo: jest.fn().mockResolvedValue(null),
  dispose: jest.fn(),
};

jest.mock('../src/server', () => ({
  VsCodeServer: jest.fn().mockImplementation(() => mockServer),
}));

jest.mock('../src/auth', () => ({
  VsCodeAuth: jest.fn(),
}));

jest.mock('../src/tunnel', () => ({
  VsCodeTunnel: jest.fn(),
}));

const mockConfigStore: Record<string, any> = {};
jest.mock('../src/config', () => ({
  VsCodeConfig: jest.fn().mockImplementation(() => ({
    get: jest.fn((key: string, defaultValue?: any) => {
      return key in mockConfigStore ? mockConfigStore[key] : defaultValue;
    }),
  })),
}));

jest.mock('../src/logger', () => ({
  VsCodeLogger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    channel: { appendLine: jest.fn() },
  })),
}));

jest.mock('../src/participant', () => ({
  registerChatParticipant: jest.fn(),
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,fake'),
}));

import * as vscode from 'vscode';
import { activate, deactivate } from '../src/extension';

// ── Helpers ───────────────────────────────────────────────────────
/** Grab the registered command handler by its ID. */
function getCommandHandler(commandId: string): (...args: any[]) => any {
  const calls = (vscode.commands.registerCommand as jest.Mock).mock.calls;
  const match = calls.find((c: any[]) => c[0] === commandId);
  if (!match) throw new Error(`Command ${commandId} not registered`);
  return match[1];
}

function makeContext(): vscode.ExtensionContext {
  const subscriptions: any[] = [];
  return {
    subscriptions,
    extensionPath: '/test',
    globalState: { get: jest.fn(), update: jest.fn() },
    secrets: { get: jest.fn(), store: jest.fn(), delete: jest.fn() },
  } as unknown as vscode.ExtensionContext;
}

// ── Tests ─────────────────────────────────────────────────────────
describe('Extension activation', () => {
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset config to defaults
    Object.keys(mockConfigStore).forEach(k => delete mockConfigStore[k]);
    mockConfigStore['autoStart'] = false; // disable auto-start by default
    context = makeContext();
  });

  describe('command registration', () => {
    it('registers all expected commands', () => {
      activate(context);
      const registered = (vscode.commands.registerCommand as jest.Mock).mock.calls.map(
        (c: any[]) => c[0],
      );
      expect(registered).toEqual(
        expect.arrayContaining([
          'mobile-copilot.start',
          'mobile-copilot.stop',
          'mobile-copilot.showQR',
          'mobile-copilot.toggleTunnel',
          'mobile-copilot.setTunnelUrl',
          'mobile-copilot.connectRelay',
          'mobile-copilot.disconnectRelay',
          'mobile-copilot.changeRoom',
          'mobile-copilot.relayMenu',
          'mobile-copilot.showExpoQR',
          'mobile-copilot.showPairingInfo',
        ]),
      );
    });
  });

  describe('getRelayUrl (via connectRelay command)', () => {
    it('uses cloud relay URL by default (relay transport)', async () => {
      mockConfigStore['transportType'] = 'relay';
      activate(context);
      const handler = getCommandHandler('mobile-copilot.connectRelay');
      await handler();
      expect(mockServer.connectRelay).toHaveBeenCalledWith('wss://gopilot-relay.onrender.com');
    });

    it('uses user-configured relay URL when set', async () => {
      mockConfigStore['transportType'] = 'relay';
      mockConfigStore['relayUrl'] = 'wss://custom.relay.io';
      activate(context);
      const handler = getCommandHandler('mobile-copilot.connectRelay');
      await handler();
      expect(mockServer.connectRelay).toHaveBeenCalledWith('wss://custom.relay.io');
    });

    it('passes undefined URL for pubsub transport', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      activate(context);
      const handler = getCommandHandler('mobile-copilot.connectRelay');
      await handler();
      expect(mockServer.connectRelay).toHaveBeenCalledWith(undefined);
    });
  });

  describe('connectRelay command', () => {
    it('starts server before connecting', async () => {
      activate(context);
      const handler = getCommandHandler('mobile-copilot.connectRelay');
      await handler();
      expect(mockServer.start).toHaveBeenCalled();
      expect(mockServer.connectRelay).toHaveBeenCalled();
    });

    it('shows error message on failure', async () => {
      mockServer.connectRelay.mockRejectedValueOnce(new Error('Network down'));
      activate(context);
      const handler = getCommandHandler('mobile-copilot.connectRelay');
      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Transport connection failed: Network down',
      );
    });
  });

  describe('disconnectRelay command', () => {
    it('delegates to server.disconnectRelay()', () => {
      activate(context);
      const handler = getCommandHandler('mobile-copilot.disconnectRelay');
      handler();
      expect(mockServer.disconnectRelay).toHaveBeenCalled();
    });
  });

  describe('changeRoom command', () => {
    it('disconnects and reconnects with a fresh code', async () => {
      jest.useFakeTimers();
      activate(context);
      const handler = getCommandHandler('mobile-copilot.changeRoom');
      const promise = handler();
      // Fast-forward the 500ms pause
      jest.advanceTimersByTime(600);
      await promise;
      expect(mockServer.disconnectRelay).toHaveBeenCalled();
      expect(mockServer.connectRelay).toHaveBeenCalled();
      jest.useRealTimers();
    });

    it('shows error on failure', async () => {
      jest.useFakeTimers();
      mockServer.connectRelay.mockRejectedValueOnce(new Error('Timeout'));
      activate(context);
      const handler = getCommandHandler('mobile-copilot.changeRoom');
      const promise = handler();
      jest.advanceTimersByTime(600);
      await promise;
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to change session: Timeout',
      );
      jest.useRealTimers();
    });
  });

  describe('relayMenu command', () => {
    it('shows quick pick with transport label for relay', async () => {
      mockConfigStore['transportType'] = 'relay';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(null);
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ placeHolder: 'Relay Session: ABC123' }),
      );
    });

    it('shows Pub/Sub specific menu when transport is pubsub', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue(null);
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.window.showQuickPick).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'pairing-qr' }),
          expect.objectContaining({ id: 'pairing-copy' }),
          expect.objectContaining({ id: 'disconnect' }),
        ]),
        expect.objectContaining({ placeHolder: 'Pub/Sub Session' }),
      );
    });

    it('copies pairing code on "copy" selection (relay mode)', async () => {
      mockConfigStore['transportType'] = 'relay';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'copy' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('ABC123');
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Pairing code copied: ABC123',
      );
    });

    it('copies pairing JSON on "pairing-copy" selection (pubsub mode)', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      const fakePairing = {
        projectId: 'test-project',
        topicName: 'GoPilot',
        mobileSubscription: 'GoPilot-mobile-sub',
        extensionSubscription: 'GoPilot-extension-sub',
        userId: 'user-123',
        accessToken: 'tok',
        tokenExpiry: Date.now() + 3_600_000,
      };
      mockServer.getPairingInfo.mockResolvedValueOnce(fakePairing);
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'pairing-copy' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith(
        JSON.stringify(fakePairing, null, 2),
      );
      expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
        'Pub/Sub pairing JSON copied to clipboard.',
      );
    });

    it('shows warning when copying pairing JSON but transport has no pairing info', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      mockServer.getPairingInfo.mockResolvedValueOnce(null);
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'pairing-copy' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Pairing info not available — is Pub/Sub transport active?',
      );
    });

    it('executes showPairingInfo on "pairing-qr" selection (pubsub mode)', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'pairing-qr' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('mobile-copilot.showPairingInfo');
    });

    it('executes changeRoom on "change" selection', async () => {
      mockConfigStore['transportType'] = 'relay';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'change' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('mobile-copilot.changeRoom');
    });

    it('executes disconnect on "disconnect" selection (relay)', async () => {
      mockConfigStore['transportType'] = 'relay';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'disconnect' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('mobile-copilot.disconnectRelay');
    });

    it('executes disconnect on "disconnect" selection (pubsub)', async () => {
      mockConfigStore['transportType'] = 'pubsub';
      (vscode.window.showQuickPick as jest.Mock).mockResolvedValue({ id: 'disconnect' });
      activate(context);
      const handler = getCommandHandler('mobile-copilot.relayMenu');
      await handler();
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith('mobile-copilot.disconnectRelay');
    });
  });

  describe('showPairingInfo command', () => {
    it('shows warning when transport has no pairing info', async () => {
      mockServer.getPairingInfo.mockResolvedValueOnce(null);
      activate(context);
      const handler = getCommandHandler('mobile-copilot.showPairingInfo');
      await handler();
      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Pairing info is only available in Pub/Sub transport mode.',
      );
    });

    it('creates webview panel when pairing info is available', async () => {
      const fakePairing = {
        projectId: 'test-project',
        topicName: 'GoPilot',
        mobileSubscription: 'GoPilot-mobile-sub',
        extensionSubscription: 'GoPilot-extension-sub',
        userId: 'user-123',
        accessToken: 'tok',
        tokenExpiry: Date.now() + 3_600_000,
      };
      mockServer.getPairingInfo.mockResolvedValueOnce(fakePairing);
      activate(context);
      const handler = getCommandHandler('mobile-copilot.showPairingInfo');
      await handler();
      expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
        'mobileCopilotPairingQR',
        'Pub/Sub Pairing — Scan to Connect',
        expect.anything(),
        expect.any(Object),
      );
    });

    it('shows error message on failure', async () => {
      mockServer.getPairingInfo.mockRejectedValueOnce(new Error('No token'));
      activate(context);
      const handler = getCommandHandler('mobile-copilot.showPairingInfo');
      await handler();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Failed to get pairing info: No token',
      );
    });
  });

  describe('auto-start', () => {
    it('auto-connects on activation when autoStart is true (relay)', async () => {
      mockConfigStore['autoStart'] = true;
      mockConfigStore['transportType'] = 'relay';
      activate(context);
      // Auto-start runs in a microtask
      await new Promise(r => setTimeout(r, 10));
      expect(mockServer.start).toHaveBeenCalled();
      expect(mockServer.connectRelay).toHaveBeenCalledWith('wss://gopilot-relay.onrender.com');
    });

    it('auto-connects on activation when autoStart is true (pubsub)', async () => {
      mockConfigStore['autoStart'] = true;
      mockConfigStore['transportType'] = 'pubsub';
      activate(context);
      await new Promise(r => setTimeout(r, 10));
      expect(mockServer.start).toHaveBeenCalled();
      expect(mockServer.connectRelay).toHaveBeenCalledWith(undefined);
    });

    it('does not auto-connect when autoStart is false', async () => {
      mockConfigStore['autoStart'] = false;
      activate(context);
      await new Promise(r => setTimeout(r, 10));
      expect(mockServer.start).not.toHaveBeenCalled();
    });

    it('handles auto-start transport failure gracefully', async () => {
      mockConfigStore['autoStart'] = true;
      mockServer.connectRelay.mockRejectedValueOnce(new Error('DNS fail'));
      activate(context);
      await new Promise(r => setTimeout(r, 10));
      // Server start still succeeds, just transport failed
      expect(mockServer.start).toHaveBeenCalled();
      // No error dialog — just logged
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('shows error if server start itself fails', async () => {
      mockConfigStore['autoStart'] = true;
      mockServer.start.mockRejectedValueOnce(new Error('Port in use'));
      activate(context);
      await new Promise(r => setTimeout(r, 10));
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Mobile Copilot auto-start failed: Port in use',
      );
    });
  });

  describe('deactivate', () => {
    it('disposes the server', async () => {
      activate(context);
      await deactivate();
      expect(mockServer.dispose).toHaveBeenCalled();
    });
  });
});
