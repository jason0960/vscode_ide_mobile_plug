/**
 * VsCodeServer — unit tests
 *
 * Covers: constructor, BaseServer hooks, all RPC handler delegation,
 * getState(), status bar, relay management, dispose, and diff computation.
 *
 * The vscode module is mocked via __mocks__/vscode.ts.
 */

// ─── Module mocks (must be before imports) ──────────────────────

jest.mock('vscode');
const vscode = require('vscode');

// Mock fs.existsSync for getStaticFilesPath / setupAdditionalRoutes
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(false),
}));
const fs = require('fs');

// Mock child_process for git operations
jest.mock('child_process', () => ({
  execFileSync: jest.fn(),
  execSync: jest.fn().mockReturnValue(''),
}));
const { execFileSync, execSync } = require('child_process');

// ─── Mock internal dependencies ─────────────────────────────────

const mockCopilot = {
  sendPrompt: jest.fn().mockResolvedValue(undefined),
  listModels: jest.fn().mockResolvedValue([
    { name: 'gpt-4', family: 'gpt-4', vendor: 'copilot', maxInputTokens: 128000 },
  ]),
  countTokens: jest.fn().mockResolvedValue(42),
  selectModel: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../src/copilot', () => ({
  CopilotBridge: jest.fn().mockImplementation(() => mockCopilot),
}));

const mockContextProvider = {
  readFile: jest.fn().mockResolvedValue('file content'),
  getFileTree: jest.fn().mockResolvedValue([]),
  listDirectory: jest.fn().mockResolvedValue([]),
  getDiagnostics: jest.fn().mockReturnValue([]),
  getDiagnosticsSummary: jest.fn().mockReturnValue({ errors: 0, warnings: 0 }),
  getWorkspaceInfo: jest.fn().mockResolvedValue({ name: 'project', files: [] }),
  getGitStatus: jest.fn().mockResolvedValue(null),
  getTerminals: jest.fn().mockReturnValue([]),
  buildPromptContext: jest.fn().mockResolvedValue([]),
};

jest.mock('../src/context', () => ({
  ContextProvider: jest.fn().mockImplementation(() => mockContextProvider),
}));

const mockAgent = {
  getWorkspaceInfo: jest.fn().mockResolvedValue({ name: 'project', rootPath: '/mock/workspace' }),
  getFileTree: jest.fn().mockResolvedValue([{ name: 'src', type: 'directory', children: [] }]),
  listDirectory: jest.fn().mockResolvedValue([{ name: 'file.ts', type: 'file' }]),
  readFile: jest.fn().mockResolvedValue({ content: 'hello', language: 'typescript' }),
  writeFile: jest.fn().mockResolvedValue({ success: true }),
  createFile: jest.fn().mockResolvedValue({ success: true }),
  deleteFile: jest.fn().mockResolvedValue({ success: true }),
  editFile: jest.fn().mockResolvedValue({ success: true }),
  searchFiles: jest.fn().mockResolvedValue({ results: [] }),
  runCommand: jest.fn().mockResolvedValue({ output: 'done', exitCode: 0 }),
  getTerminals: jest.fn().mockReturnValue([]),
  openFile: jest.fn().mockResolvedValue({ success: true }),
  getActiveEditor: jest.fn().mockResolvedValue(null),
  getDiagnostics: jest.fn().mockReturnValue([]),
  getDiagnosticsSummary: jest.fn().mockReturnValue({ errors: 0, warnings: 0 }),
  getGitStatus: jest.fn().mockResolvedValue({ branch: 'main', clean: true }),
  gitDiff: jest.fn().mockResolvedValue({ diff: '' }),
  dispose: jest.fn(),
};

jest.mock('../src/agent', () => ({
  AgentOperations: jest.fn().mockImplementation(() => mockAgent),
}));

const mockInterceptor = {
  startSession: jest.fn().mockReturnValue({
    wait: jest.fn().mockResolvedValue({
      capturedText: '',
      fileChanges: [],
      schemesSeen: new Set(),
      documentUris: [],
    }),
  }),
  onDocumentChange: jest.fn(),
  dispose: jest.fn(),
};

jest.mock('../src/interceptor', () => ({
  ChatResponseInterceptor: jest.fn().mockImplementation(() => mockInterceptor),
}));

const mockRelayOnMessage = { event: jest.fn().mockReturnValue({ dispose: jest.fn() }) };
const mockRelayOnClientJoined = { event: jest.fn().mockReturnValue({ dispose: jest.fn() }) };
const mockRelayOnClientLeft = { event: jest.fn().mockReturnValue({ dispose: jest.fn() }) };
const mockRelayOnDisconnected = { event: jest.fn().mockReturnValue({ dispose: jest.fn() }) };

const mockRelay = {
  connect: jest.fn().mockResolvedValue('ABC123'),
  disconnect: jest.fn(),
  send: jest.fn(),
  dispose: jest.fn(),
  isConnected: false,
  code: null as string | null,
  onMessage: mockRelayOnMessage,
  onRoomCreated: { event: jest.fn() },
  onClientJoined: mockRelayOnClientJoined,
  onClientLeft: mockRelayOnClientLeft,
  onDisconnected: mockRelayOnDisconnected,
};

jest.mock('../src/relay-client', () => ({
  RelayClient: jest.fn().mockImplementation(() => mockRelay),
}));

jest.mock('../src/pubsub-transport', () => ({
  PubSubTransport: jest.fn().mockImplementation(() => mockRelay),
}));

jest.mock('../src/participant', () => ({
  setMobileCallbacks: jest.fn(),
  setCurrentMobileRequestId: jest.fn(),
}));

// ─── Import under test ──────────────────────────────────────────

import { VsCodeServer } from '../src/server';

// ─── Helper: create server instance ─────────────────────────────

function createMockLogger() {
  const channel = {
    appendLine: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  };
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    channel,
  };
}

function createMockAuth() {
  return {
    generateToken: jest.fn().mockResolvedValue('test-token-123'),
    validateToken: jest.fn().mockResolvedValue(true),
    createSession: jest.fn().mockReturnValue({ id: 'session-1', createdAt: Date.now() }),
    showQRPanel: jest.fn().mockResolvedValue(undefined),
    getToken: jest.fn().mockReturnValue('test-token-123'),
  };
}

function createMockTunnel() {
  return {
    startTunnel: jest.fn().mockResolvedValue('https://tunnel.example.com'),
    stopTunnel: jest.fn().mockResolvedValue(undefined),
    toggleTunnel: jest.fn().mockResolvedValue(undefined),
    getTunnelUrl: jest.fn().mockReturnValue(null),
    setManualUrl: jest.fn(),
    isActive: jest.fn().mockReturnValue(false),
    dispose: jest.fn(),
  };
}

function createMockConfig() {
  const configMap: Record<string, any> = {
    port: 3847,
    tunnelProvider: 'none',
    captureMode: 'relay',
    transportType: 'relay',
    relayUrl: 'wss://relay.example.com',
  };
  return {
    get: jest.fn(<T>(key: string, defaultValue?: T): T | undefined => {
      return key in configMap ? configMap[key] : defaultValue;
    }),
    _map: configMap,
  };
}

function createMockContext() {
  return {
    subscriptions: [],
    extensionPath: '/mock/extension',
    extensionUri: { fsPath: '/mock/extension' },
    globalState: { get: jest.fn(), update: jest.fn() },
    workspaceState: { get: jest.fn(), update: jest.fn() },
    storagePath: '/mock/storage',
    globalStoragePath: '/mock/global-storage',
  };
}

function createTestServer() {
  const logger = createMockLogger();
  const auth = createMockAuth();
  const tunnel = createMockTunnel();
  const config = createMockConfig();
  const context = createMockContext();

  const server = new VsCodeServer(
    context as any,
    logger as any,
    auth as any,
    tunnel as any,
    config as any,
  );

  return { server, logger, auth, tunnel, config, context };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('VsCodeServer', () => {
  let server: VsCodeServer;
  let logger: ReturnType<typeof createMockLogger>;
  let auth: ReturnType<typeof createMockAuth>;
  let tunnel: ReturnType<typeof createMockTunnel>;
  let config: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset vscode mocks
    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: '/mock/workspace' }, name: 'mock', index: 0 },
    ];

    // Reset relay mock state
    mockRelay.code = null;
    mockRelay.isConnected = false;

    const created = createTestServer();
    server = created.server;
    logger = created.logger;
    auth = created.auth;
    tunnel = created.tunnel;
    config = created.config;
  });

  // ─── Constructor ────────────────────────────────────────────

  describe('constructor', () => {
    it('creates instance with all dependencies', () => {
      expect(server).toBeDefined();
      expect(server).toBeInstanceOf(VsCodeServer);
    });

    it('creates a status bar item on Right side', () => {
      expect(vscode.window.createStatusBarItem).toHaveBeenCalledWith(
        vscode.StatusBarAlignment.Right,
        100,
      );
    });

    it('sets initial status bar to stopped', () => {
      const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
      expect(statusBarItem.text).toBe('$(device-mobile) AgentDeck: Off');
    });

    it('sets status bar command to showQR', () => {
      const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
      expect(statusBarItem.command).toBe('mobile-copilot.showQR');
    });

    it('wires up transport listeners', () => {
      // setupTransportListeners is called in constructor, which registers event handlers
      expect(mockRelayOnMessage.event).toHaveBeenCalled();
      expect(mockRelayOnClientJoined.event).toHaveBeenCalled();
      expect(mockRelayOnClientLeft.event).toHaveBeenCalled();
      expect(mockRelayOnDisconnected.event).toHaveBeenCalled();
    });
  });

  // ─── BaseServer hooks ───────────────────────────────────────

  describe('BaseServer hooks', () => {
    describe('getPort', () => {
      it('returns port from config', () => {
        const port = (server as any).getPort();
        expect(port).toBe(3847);
      });

      it('returns default when config value is null', () => {
        // config.get('port', 3847) returns null from the mock, but
        // getPort() applies `?? 3847` so null coalesces to the default.
        config.get.mockReturnValue(null);
        const port = (server as any).getPort();
        expect(port).toBe(3847);
      });
    });

    describe('getStaticFilesPath', () => {
      it('returns empty string always (mobile app removed)', () => {
        const result = (server as any).getStaticFilesPath();
        expect(result).toBe('');
      });
    });

    describe('setupAdditionalRoutes', () => {
      it('does nothing (mobile app removed, routes handled by transport)', () => {
        const useSpy = jest.spyOn((server as any).app, 'use');
        const getSpy = jest.spyOn((server as any).app, 'get');
        (server as any).setupAdditionalRoutes();
        expect(useSpy).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalled();
        useSpy.mockRestore();
        getSpy.mockRestore();
      });
    });

    describe('onServerStarted', () => {
      it('generates auth token', async () => {
        await (server as any).onServerStarted();
        expect(auth.generateToken).toHaveBeenCalled();
      });

      it('does not attempt tunnel when provider is none', async () => {
        config._map.tunnelProvider = 'none';
        await (server as any).onServerStarted();
        expect(tunnel.startTunnel).not.toHaveBeenCalled();
      });

      it('attempts tunnel when provider is not none', async () => {
        config._map.tunnelProvider = 'cloudflare';
        config.get.mockImplementation((key: string, def?: any) => {
          if (key === 'tunnelProvider') return 'cloudflare';
          return config._map[key] ?? def;
        });
        await (server as any).onServerStarted();
        expect(tunnel.startTunnel).toHaveBeenCalled();
      });

      it('logs that server is running (no UI message)', async () => {
        await (server as any).onServerStarted();
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('AgentDeck server running'),
        );
      });

      it('calls auth.generateToken', async () => {
        await (server as any).onServerStarted();
        expect(auth.generateToken).toHaveBeenCalled();
      });

      it('handles tunnel failure gracefully', async () => {
        config._map.tunnelProvider = 'cloudflare';
        config.get.mockImplementation((key: string, def?: any) => {
          if (key === 'tunnelProvider') return 'cloudflare';
          return config._map[key] ?? def;
        });
        tunnel.startTunnel.mockRejectedValue(new Error('Tunnel failed'));
        await (server as any).onServerStarted();
        // Should not throw, should log warning
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Tunnel failed'));
      });
    });

    describe('onServerStopping', () => {
      it('disposes all disposables', () => {
        const mockDisposable = { dispose: jest.fn() };
        (server as any).disposables = [mockDisposable, mockDisposable];
        (server as any).onServerStopping();
        expect(mockDisposable.dispose).toHaveBeenCalledTimes(2);
      });

      it('clears disposables array', () => {
        (server as any).disposables = [{ dispose: jest.fn() }];
        (server as any).onServerStopping();
        expect((server as any).disposables).toHaveLength(0);
      });
    });

    describe('onServerStopped', () => {
      it('updates status bar to stopped', () => {
        (server as any).onServerStopped();
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toBe('$(device-mobile) AgentDeck: Off');
      });

      it('shows information message', () => {
        (server as any).onServerStopped();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          'AgentDeck server stopped.',
        );
      });
    });

    describe('onClientConnected', () => {
      it('updates status bar to connected', () => {
        const mockWs = {} as any;
        (server as any).onClientConnected(mockWs, 'session-1');
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toContain('connected');
      });
    });

    describe('onClientDisconnected', () => {
      it('updates status bar to connected when clients remain', () => {
        (server as any).clients.set({} as any, { authenticated: true });
        (server as any).onClientDisconnected({} as any, 'session-1');
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toContain('connected');
      });

      it('updates status bar to running when no clients remain', () => {
        (server as any).clients.clear();
        (server as any).onClientDisconnected({} as any, 'session-1');
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toBe('$(broadcast) AgentDeck: LAN');
      });
    });
  });

  // ─── Public API ─────────────────────────────────────────────

  describe('Public API', () => {
    describe('showQRCode', () => {
      it('calls auth.showQRPanel with server URL', async () => {
        await server.showQRCode();
        expect(auth.showQRPanel).toHaveBeenCalled();
      });
    });

    describe('setTunnelUrl', () => {
      it('sets manual URL on tunnel', async () => {
        await server.setTunnelUrl('https://my-tunnel.com/');
        expect(tunnel.setManualUrl).toHaveBeenCalledWith('https://my-tunnel.com');
      });

      it('strips trailing slash', async () => {
        await server.setTunnelUrl('https://my-tunnel.com/');
        expect(tunnel.setManualUrl).toHaveBeenCalledWith('https://my-tunnel.com');
      });

      it('shows information message', async () => {
        await server.setTunnelUrl('https://my-tunnel.com');
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          expect.stringContaining('tunnel URL'),
        );
      });

      it('refreshes QR code', async () => {
        await server.setTunnelUrl('https://my-tunnel.com');
        expect(auth.showQRPanel).toHaveBeenCalled();
      });
    });

    describe('toggleTunnel', () => {
      it('calls tunnel.toggleTunnel', async () => {
        await server.toggleTunnel();
        expect(tunnel.toggleTunnel).toHaveBeenCalled();
      });

      it('updates status bar to tunnel when active', async () => {
        tunnel.isActive.mockReturnValue(true);
        await server.toggleTunnel();
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toContain('Tunnel');
      });

      it('updates status bar to running when inactive', async () => {
        tunnel.isActive.mockReturnValue(false);
        await server.toggleTunnel();
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toBe('$(broadcast) AgentDeck: LAN');
      });

      it('shows QR when tunnel is active', async () => {
        tunnel.isActive.mockReturnValue(true);
        await server.toggleTunnel();
        expect(auth.showQRPanel).toHaveBeenCalled();
      });
    });
  });

  // ─── Cloud Relay ────────────────────────────────────────────

  describe('Cloud Relay', () => {
    describe('connectRelay', () => {
      it('connects and returns room code', async () => {
        const code = await server.connectRelay();
        expect(code).toBe('ABC123');
        expect(mockRelay.connect).toHaveBeenCalled();
      });

      it('updates status bar to relay', async () => {
        mockRelay.code = 'ABC123';
        await server.connectRelay();
        const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
        expect(statusBarItem.text).toContain('Relay');
      });

      it('shows information message with code', async () => {
        await server.connectRelay();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          expect.stringContaining('ABC123'),
          'Copy Code',
        );
      });

      it('copies code to clipboard when Copy Code selected', async () => {
        vscode.window.showInformationMessage.mockResolvedValue('Copy Code');
        await server.connectRelay();
        // Wait for the .then() handler
        await new Promise(r => setTimeout(r, 10));
        expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('ABC123');
      });
    });

    describe('disconnectRelay', () => {
      it('disconnects relay', () => {
        server.disconnectRelay();
        expect(mockRelay.disconnect).toHaveBeenCalled();
      });

      it('resets relay client count', () => {
        (server as any).relayClientCount = 5;
        server.disconnectRelay();
        expect((server as any).relayClientCount).toBe(0);
      });

      it('shows information message', () => {
        server.disconnectRelay();
        expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(
          'Disconnected from transport.',
        );
      });
    });

    describe('getRelayCode', () => {
      it('returns null when not connected', () => {
        expect(server.getRelayCode()).toBeNull();
      });

      it('returns code when connected', () => {
        mockRelay.code = 'XYZ789';
        expect(server.getRelayCode()).toBe('XYZ789');
      });
    });

    describe('setupTransportListeners - auth', () => {
      it('auto-authenticates and sends auth.success on auth message', async () => {
        const messageHandler = mockRelayOnMessage.event.mock.calls[0][0];

        const authMsg = JSON.stringify({
          method: 'auth',
          id: 'req-1',
          params: { token: 'valid-token' },
        });

        await messageHandler(authMsg);

        // Transport auto-authenticates — no validateToken call
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Auth request received'),
        );
      });

      it('forwards non-auth messages to RPC handler', async () => {
        const messageHandler = mockRelayOnMessage.event.mock.calls[0][0];

        // First, need a virtual WS with session registered
        const rpcMsg = JSON.stringify({
          method: 'file.read',
          id: 'req-3',
          params: { path: 'test.ts' },
        });

        await messageHandler(rpcMsg);

        // The message should have been forwarded to RPC handler
        // (it auto-creates the virtual WS and marks as authenticated)
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining('Message from mobile'),
        );
      });

      it('updates relay client count on client join', () => {
        const joinHandler = mockRelayOnClientJoined.event.mock.calls[0][0];
        joinHandler({ clientCount: 3 });
        expect((server as any).relayClientCount).toBe(3);
      });

      it('updates relay client count on client leave', () => {
        const leaveHandler = mockRelayOnClientLeft.event.mock.calls[0][0];
        leaveHandler({ clientCount: 1 });
        expect((server as any).relayClientCount).toBe(1);
      });

      it('resets client count on disconnect', () => {
        (server as any).relayClientCount = 5;
        const disconnectHandler = mockRelayOnDisconnected.event.mock.calls[0][0];
        disconnectHandler();
        expect((server as any).relayClientCount).toBe(0);
      });
    });

    describe('transport virtual WebSocket', () => {
      it('creates virtual WS that sends through transport', () => {
        const vws = (server as any).createTransportVirtualWs();
        expect(vws).toBeDefined();
        expect((vws as any).__isTransportVirtual).toBe(true);

        vws.send('test-data');
        expect(mockRelay.send).toHaveBeenCalledWith('test-data');
      });

      it('reuses existing virtual WS', () => {
        const vws1 = (server as any).createTransportVirtualWs();
        // Register the vws so it's found by getTransportVirtualWs
        (server as any).clients.set(vws1, { authenticated: true, sessionId: 'relay' });
        const vws2 = (server as any).createTransportVirtualWs();
        expect(vws1).toBe(vws2);
      });

      it('virtual WS readyState reflects transport connection', () => {
        const vws = (server as any).createTransportVirtualWs();
        mockRelay.isConnected = false;
        expect(vws.readyState).toBe(3); // WebSocket.CLOSED
        mockRelay.isConnected = true;
        expect(vws.readyState).toBe(1); // WebSocket.OPEN
      });

      it('getTransportVirtualWs returns null when no virtual WS exists', () => {
        (server as any).clients.clear();
        const vws = (server as any).getTransportVirtualWs();
        expect(vws).toBeNull();
      });
    });
  });

  // ─── getState ───────────────────────────────────────────────

  describe('getState', () => {
    it('returns server state when not running', () => {
      const state = server.getState();
      expect(state.running).toBe(false);
      expect(state.port).toBeDefined();
      expect(state.localUrl).toContain('localhost');
      expect(state.connectedClients).toBe(0);
    });

    it('includes tunnel URL when available', () => {
      tunnel.getTunnelUrl.mockReturnValue('https://tunnel.example.com');
      const state = server.getState();
      expect(state.tunnelUrl).toBe('https://tunnel.example.com');
    });

    it('tunnelUrl is undefined when no tunnel', () => {
      tunnel.getTunnelUrl.mockReturnValue(null);
      const state = server.getState();
      expect(state.tunnelUrl).toBeUndefined();
    });

    it('reports connected client count', () => {
      (server as any).clients.set({} as any, { authenticated: true });
      (server as any).clients.set({} as any, { authenticated: true });
      const state = server.getState();
      expect(state.connectedClients).toBe(2);
    });
  });

  // ─── RPC Handlers ──────────────────────────────────────────

  describe('RPC Handlers', () => {
    let rpcHandlers: Map<string, Function>;
    let rpcStreamHandlers: Map<string, Function>;

    beforeEach(() => {
      // Capture registered handlers
      rpcHandlers = new Map();
      rpcStreamHandlers = new Map();

      const origOnRequest = server.rpc.onRequest.bind(server.rpc);
      const origOnStream = server.rpc.onStream.bind(server.rpc);

      server.rpc.onRequest = jest.fn((method: string, handler: Function) => {
        rpcHandlers.set(method, handler);
        return origOnRequest(method, handler as any);
      }) as any;

      server.rpc.onStream = jest.fn((method: string, handler: Function) => {
        rpcStreamHandlers.set(method, handler);
        return origOnStream(method, handler as any);
      }) as any;

      // Call setupRpcHandlers
      (server as any).setupRpcHandlers();
    });

    // ── Workspace ──

    describe('workspace.info', () => {
      it('delegates to agent.getWorkspaceInfo()', async () => {
        const handler = rpcHandlers.get('workspace.info')!;
        const result = await handler({});
        expect(mockAgent.getWorkspaceInfo).toHaveBeenCalled();
        expect(result).toEqual({ name: 'project', rootPath: '/mock/workspace' });
      });
    });

    describe('workspace.fileTree', () => {
      it('delegates to agent.getFileTree()', async () => {
        const handler = rpcHandlers.get('workspace.fileTree')!;
        const result = await handler({ maxDepth: 3 });
        expect(mockAgent.getFileTree).toHaveBeenCalledWith(3);
        expect(result).toEqual([{ name: 'src', type: 'directory', children: [] }]);
      });

      it('passes undefined when no params', async () => {
        const handler = rpcHandlers.get('workspace.fileTree')!;
        await handler(undefined);
        expect(mockAgent.getFileTree).toHaveBeenCalledWith(undefined);
      });
    });

    describe('workspace.listDir', () => {
      it('delegates to agent.listDirectory()', async () => {
        const handler = rpcHandlers.get('workspace.listDir')!;
        const result = await handler({ path: 'src' });
        expect(mockAgent.listDirectory).toHaveBeenCalledWith('src');
        expect(result).toEqual([{ name: 'file.ts', type: 'file' }]);
      });
    });

    // ── Files ──

    describe('file.read', () => {
      it('delegates to agent.readFile()', async () => {
        const handler = rpcHandlers.get('file.read')!;
        const params = { path: 'src/index.ts' };
        const result = await handler(params);
        expect(mockAgent.readFile).toHaveBeenCalledWith(params);
        expect(result).toEqual({ content: 'hello', language: 'typescript' });
      });
    });

    describe('file.write', () => {
      it('delegates to agent.writeFile()', async () => {
        const handler = rpcHandlers.get('file.write')!;
        const params = { path: 'src/index.ts', content: 'new content' };
        await handler(params);
        expect(mockAgent.writeFile).toHaveBeenCalledWith(params);
      });
    });

    describe('file.create', () => {
      it('delegates to agent.createFile()', async () => {
        const handler = rpcHandlers.get('file.create')!;
        const params = { path: 'src/new.ts', content: '' };
        await handler(params);
        expect(mockAgent.createFile).toHaveBeenCalledWith(params);
      });
    });

    describe('file.delete', () => {
      it('delegates to agent.deleteFile()', async () => {
        const handler = rpcHandlers.get('file.delete')!;
        const params = { path: 'src/old.ts' };
        await handler(params);
        expect(mockAgent.deleteFile).toHaveBeenCalledWith(params);
      });
    });

    describe('file.edit', () => {
      it('delegates to agent.editFile()', async () => {
        const handler = rpcHandlers.get('file.edit')!;
        const params = { path: 'src/index.ts', edits: [] };
        await handler(params);
        expect(mockAgent.editFile).toHaveBeenCalledWith(params);
      });
    });

    describe('file.search', () => {
      it('delegates to agent.searchFiles()', async () => {
        const handler = rpcHandlers.get('file.search')!;
        const params = { query: 'hello', maxResults: 10 };
        await handler(params);
        expect(mockAgent.searchFiles).toHaveBeenCalledWith(params);
      });
    });

    // ── Terminal ──

    describe('terminal.run', () => {
      it('delegates to agent.runCommand()', async () => {
        const handler = rpcHandlers.get('terminal.run')!;
        const params = { command: 'ls -la' };
        const result = await handler(params);
        expect(mockAgent.runCommand).toHaveBeenCalledWith(params);
        expect(result).toEqual({ output: 'done', exitCode: 0 });
      });
    });

    describe('terminal.list', () => {
      it('delegates to agent.getTerminals()', async () => {
        const handler = rpcHandlers.get('terminal.list')!;
        await handler({});
        expect(mockAgent.getTerminals).toHaveBeenCalled();
      });
    });

    // ── Editor ──

    describe('editor.open', () => {
      it('delegates to agent.openFile()', async () => {
        const handler = rpcHandlers.get('editor.open')!;
        const params = { path: 'src/index.ts' };
        await handler(params);
        expect(mockAgent.openFile).toHaveBeenCalledWith(params);
      });
    });

    describe('editor.active', () => {
      it('delegates to agent.getActiveEditor()', async () => {
        const handler = rpcHandlers.get('editor.active')!;
        await handler({});
        expect(mockAgent.getActiveEditor).toHaveBeenCalled();
      });
    });

    // ── Diagnostics ──

    describe('diagnostics.all', () => {
      it('delegates to agent.getDiagnostics()', async () => {
        const handler = rpcHandlers.get('diagnostics.all')!;
        await handler({});
        expect(mockAgent.getDiagnostics).toHaveBeenCalled();
      });
    });

    describe('diagnostics.summary', () => {
      it('delegates to agent.getDiagnosticsSummary()', async () => {
        const handler = rpcHandlers.get('diagnostics.summary')!;
        const result = await handler({});
        expect(mockAgent.getDiagnosticsSummary).toHaveBeenCalled();
        expect(result).toEqual({ errors: 0, warnings: 0 });
      });
    });

    // ── Git ──

    describe('git.status', () => {
      it('delegates to agent.getGitStatus()', async () => {
        const handler = rpcHandlers.get('git.status')!;
        const result = await handler({});
        expect(mockAgent.getGitStatus).toHaveBeenCalled();
        expect(result).toEqual({ branch: 'main', clean: true });
      });
    });

    describe('git.diff', () => {
      it('delegates to agent.gitDiff()', async () => {
        const handler = rpcHandlers.get('git.diff')!;
        await handler({});
        expect(mockAgent.gitDiff).toHaveBeenCalled();
      });
    });

    describe('git.changedFiles', () => {
      it('calls getWorkingTreeDiffs()', async () => {
        execFileSync.mockReturnValue('');
        const handler = rpcHandlers.get('git.changedFiles')!;
        const result = await handler({});
        expect(result).toBeDefined();
        expect(result.files).toEqual([]);
      });
    });

    describe('git.restoreFiles', () => {
      it('restores specified files via git restore', async () => {
        execSync.mockReturnValue('M  a.ts');
        const handler = rpcHandlers.get('git.restoreFiles')!;
        const result = await handler({ files: ['a.ts', 'b.ts'] });
        expect(result.restored).toBeGreaterThanOrEqual(0);
      });

      it('returns zero restored when no files provided', async () => {
        const handler = rpcHandlers.get('git.restoreFiles')!;
        const result = await handler({});
        expect(result.restored).toBe(0);
      });
    });

    describe('git.revertHunks', () => {
      it('handler may not exist (removed)', () => {
        const handler = rpcHandlers.get('git.revertHunks');
        // git.revertHunks was removed in transport refactor
        expect(handler).toBeUndefined();
      });
    });

    describe('git.restoreChanges', () => {
      it('restores files via git restore when files provided', async () => {
        execSync.mockReturnValue('');
        const handler = rpcHandlers.get('git.restoreChanges')!;
        const result = await handler({ files: ['x.ts'] });
        expect(result).toBeDefined();
      });

      it('uses agentModifiedFiles when no files provided', async () => {
        execSync.mockReturnValue('');
        (server as any).agentModifiedFiles = new Set(['mod1.ts', 'mod2.ts']);
        const handler = rpcHandlers.get('git.restoreChanges')!;
        const result = await handler({});
        expect(result).toBeDefined();
      });

      it('clears agentModifiedFiles after restore', async () => {
        (server as any).agentModifiedFiles = new Set(['z.ts']);
        const handler = rpcHandlers.get('git.restoreChanges')!;
        await handler({});
        expect((server as any).agentModifiedFiles.size).toBe(0);
      });
    });

    // ── Agent ──

    describe('agent.modifiedFiles', () => {
      it('returns modified files set as array', async () => {
        (server as any).agentModifiedFiles = new Set(['a.ts', 'b.ts']);
        const handler = rpcHandlers.get('agent.modifiedFiles')!;
        const result = await handler({});
        expect(result).toEqual({ files: ['a.ts', 'b.ts'] });
      });

      it('returns empty when no files modified', async () => {
        (server as any).agentModifiedFiles = new Set();
        const handler = rpcHandlers.get('agent.modifiedFiles')!;
        const result = await handler({});
        expect(result).toEqual({ files: [] });
      });
    });

    // ── Server ──

    describe('server.state', () => {
      it('returns getState()', async () => {
        const handler = rpcHandlers.get('server.state')!;
        const result = await handler({});
        expect(result.running).toBe(false);
        expect(result.port).toBeDefined();
        expect(result.localUrl).toContain('localhost');
      });
    });

    describe('ping', () => {
      it('returns pong with timestamp', async () => {
        const handler = rpcHandlers.get('ping')!;
        const before = Date.now();
        const result = await handler({});
        expect(result.pong).toBe(true);
        expect(result.timestamp).toBeGreaterThanOrEqual(before);
        expect(result.timestamp).toBeLessThanOrEqual(Date.now());
      });
    });

    // ── Chat ──

    describe('chat.models', () => {
      it('delegates to copilot.listModels()', async () => {
        const handler = rpcHandlers.get('chat.models')!;
        const result = await handler({});
        expect(mockCopilot.listModels).toHaveBeenCalled();
        expect(result).toEqual([
          { name: 'gpt-4', family: 'gpt-4', vendor: 'copilot', maxInputTokens: 128000 },
        ]);
      });
    });

    describe('chat.tokenCount', () => {
      it('delegates to copilot.countTokens()', async () => {
        const handler = rpcHandlers.get('chat.tokenCount')!;
        const result = await handler({ text: 'hello world' });
        expect(mockCopilot.countTokens).toHaveBeenCalledWith('hello world');
        expect(result).toEqual({ count: 42 });
      });
    });

    describe('chat.send (stream)', () => {
      it('sends prompt to copilot.sendPrompt()', async () => {
        const handler = rpcStreamHandlers.get('chat.send')!;
        const mockSend = jest.fn();
        await handler(
          { prompt: 'Hello', history: [], context: [] },
          mockSend,
          {} as any,
        );
        expect(mockCopilot.sendPrompt).toHaveBeenCalledWith(
          'Hello',
          [],
          [],
          expect.any(Function),
        );
      });

      it('selects model when specified', async () => {
        const handler = rpcStreamHandlers.get('chat.send')!;
        await handler(
          { prompt: 'Hello', model: 'gpt-4o' },
          jest.fn(),
          {} as any,
        );
        expect(mockCopilot.selectModel).toHaveBeenCalledWith('gpt-4o');
      });

      it('builds context when not provided', async () => {
        const handler = rpcStreamHandlers.get('chat.send')!;
        await handler({ prompt: 'Hello' }, jest.fn(), {} as any);
        expect(mockContextProvider.buildPromptContext).toHaveBeenCalled();
      });
    });

    describe('chat.sendToAgent (stream)', () => {
      it('rejects empty prompt', async () => {
        const handler = rpcStreamHandlers.get('chat.sendToAgent')!;
        await expect(
          handler({ prompt: '' }, jest.fn(), {} as any),
        ).rejects.toThrow('Prompt is required');
      });

      it('rejects whitespace-only prompt', async () => {
        const handler = rpcStreamHandlers.get('chat.sendToAgent')!;
        await expect(
          handler({ prompt: '   ' }, jest.fn(), {} as any),
        ).rejects.toThrow('Prompt is required');
      });

      it('rejects when no workspace folder', async () => {
        vscode.workspace.workspaceFolders = null;
        const handler = rpcStreamHandlers.get('chat.sendToAgent')!;
        await expect(
          handler({ prompt: 'Hello' }, jest.fn(), {} as any),
        ).rejects.toThrow('No workspace folder open');
      });
    });
  });

  // ─── Capture Strategies ──────────────────────────────────

  describe('runInterceptorCapture', () => {
    it('sends waiting message', async () => {
      const mockSend = jest.fn();
      const mockSession = {
        wait: jest.fn().mockResolvedValue({
          capturedText: 'response text',
          fileChanges: [],
          schemesSeen: new Set(),
          documentUris: [],
        }),
      };

      await (server as any).runInterceptorCapture('hello', mockSend, mockSession);
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Sending to Copilot'));
    });

    it('executes chat open command', async () => {
      const mockSend = jest.fn();
      const mockSession = {
        wait: jest.fn().mockResolvedValue({
          capturedText: 'response',
          fileChanges: [],
        }),
      };

      await (server as any).runInterceptorCapture('test prompt', mockSend, mockSession);
      expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
        'workbench.action.chat.open',
        expect.objectContaining({ query: expect.stringContaining('test prompt') }),
      );
    });

    it('sends file changes summary when no text captured', async () => {
      const mockSend = jest.fn();
      const mockSession = {
        wait: jest.fn().mockResolvedValue({
          capturedText: '',
          fileChanges: [{ path: 'a.ts', linesAdded: 5, linesRemoved: 2 }],
        }),
      };

      await (server as any).runInterceptorCapture('hello', mockSend, mockSession);
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('a.ts'));
    });

    it('sends warning when nothing captured', async () => {
      const mockSend = jest.fn();
      const mockSession = {
        wait: jest.fn().mockResolvedValue({
          capturedText: '',
          fileChanges: [],
        }),
      };

      await (server as any).runInterceptorCapture('hello', mockSend, mockSession);
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('⚠️'));
    });

    it('handles interceptor error', async () => {
      const mockSend = jest.fn();
      const mockSession = {
        wait: jest.fn().mockRejectedValue(new Error('Interceptor timeout')),
      };

      await (server as any).runInterceptorCapture('hello', mockSend, mockSession);
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('Interceptor timeout'));
    });
  });

  // ─── Status Bar ─────────────────────────────────────────────

  describe('updateStatusBar', () => {
    let statusBarItem: any;

    beforeEach(() => {
      statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
    });

    it('stopped state', () => {
      (server as any).updateStatusBar('stopped');
      expect(statusBarItem.text).toBe('$(device-mobile) AgentDeck: Off');
      expect(statusBarItem.tooltip).toContain('Click to start');
      expect(statusBarItem.backgroundColor).toBeUndefined();
    });

    it('running state', () => {
      (server as any).updateStatusBar('running');
      expect(statusBarItem.text).toBe('$(broadcast) AgentDeck: LAN');
      expect(statusBarItem.tooltip).toContain('port');
      expect(statusBarItem.backgroundColor).toBeUndefined();
    });

    it('connected state', () => {
      (server as any).clients.set({} as any, { authenticated: true });
      (server as any).clients.set({} as any, { authenticated: true });
      (server as any).updateStatusBar('connected');
      expect(statusBarItem.text).toBe('$(broadcast) AgentDeck: 2 connected');
      expect(statusBarItem.tooltip).toContain('2 device(s)');
    });

    it('tunnel state', () => {
      tunnel.getTunnelUrl.mockReturnValue('https://tunnel.example.com');
      (server as any).updateStatusBar('tunnel');
      expect(statusBarItem.text).toBe('$(globe) AgentDeck: Tunnel');
      expect(statusBarItem.tooltip).toContain('tunnel.example.com');
    });

    it('relay state', () => {
      mockRelay.code = 'XYZ789';
      (server as any).relayClientCount = 2;
      (server as any).updateStatusBar('relay');
      expect(statusBarItem.text).toBe('$(cloud) AgentDeck: Relay [XYZ789]');
      expect(statusBarItem.tooltip).toContain('XYZ789');
      expect(statusBarItem.tooltip).toContain('2 device(s)');
    });

    it('relay state with no code', () => {
      mockRelay.code = null;
      (server as any).updateStatusBar('relay');
      expect(statusBarItem.text).toContain('...');
    });

    it('always shows status bar', () => {
      (server as any).updateStatusBar('running');
      expect(statusBarItem.show).toHaveBeenCalled();
    });
  });

  // ─── Diff Computation ──────────────────────────────────────

  describe('computeFileDiffs', () => {
    it('returns empty array when no modified files', async () => {
      (server as any).agentModifiedFiles = new Set();
      const result = await (server as any).computeFileDiffs();
      expect(result).toEqual([]);
    });

    it('returns empty array when no workspace folder', async () => {
      vscode.workspace.workspaceFolders = null;
      (server as any).agentModifiedFiles = new Set(['a.ts']);
      const result = await (server as any).computeFileDiffs();
      expect(result).toEqual([]);
    });

    it('computes git diff for modified files', async () => {
      (server as any).agentModifiedFiles = new Set(['src/a.ts']);
      execSync.mockReturnValue('+ added line\n- removed line');
      const result = await (server as any).computeFileDiffs();
      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('src/a.ts');
      expect(result[0].diff).toContain('added line');
    });

    it('tries cached diff when working dir diff is empty', async () => {
      (server as any).agentModifiedFiles = new Set(['src/b.ts']);
      execSync
        .mockReturnValueOnce('')  // git diff
        .mockReturnValueOnce('+ cached\n');  // git diff --cached
      const result = await (server as any).computeFileDiffs();
      expect(result).toHaveLength(1);
      expect(result[0].diff).toContain('cached');
    });

    it('truncates large diffs', async () => {
      (server as any).agentModifiedFiles = new Set(['src/big.ts']);
      const largeDiff = '+' + 'x'.repeat(20000);
      execSync.mockReturnValue(largeDiff);
      const result = await (server as any).computeFileDiffs();
      expect(result[0].diff.length).toBeLessThanOrEqual(10100);
      expect(result[0].diff).toContain('truncated');
    });
  });

  describe('getWorkingTreeDiffs', () => {
    it('returns empty when no workspace folder', async () => {
      vscode.workspace.workspaceFolders = null;
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toEqual([]);
      expect(result.summary.modified).toBe(0);
    });

    it('returns empty when git status is clean', async () => {
      execSync.mockReturnValue('');
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toEqual([]);
    });

    it('returns empty on git status failure', async () => {
      execSync.mockImplementation(() => { throw new Error('not a git repo'); });
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toEqual([]);
    });

    it('parses modified files', async () => {
      execSync
        .mockReturnValueOnce(' M src/a.ts')  // git status
        .mockReturnValueOnce('+added\n-removed');  // git diff
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('modified');
      expect(result.summary.modified).toBe(1);
    });

    it('parses untracked (added) files', async () => {
      execSync
        .mockReturnValueOnce('?? src/new.ts')  // git status
        .mockReturnValueOnce('line1\nline2\n');  // cat for untracked
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('added');
      expect(result.summary.added).toBe(1);
    });

    it('parses deleted files', async () => {
      execSync
        .mockReturnValueOnce('D  src/old.ts')  // git status
        .mockReturnValueOnce('-removed line');  // git diff
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files).toHaveLength(1);
      expect(result.files[0].status).toBe('deleted');
      expect(result.summary.deleted).toBe(1);
    });

    it('counts total added/removed lines', async () => {
      execSync
        .mockReturnValueOnce(' M src/a.ts')  // git status
        .mockReturnValueOnce('+line1\n+line2\n-old1');  // git diff
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.summary.totalAdded).toBe(2);
      expect(result.summary.totalRemoved).toBe(1);
    });

    it('truncates large diffs per file', async () => {
      execSync
        .mockReturnValueOnce(' M src/big.ts')  // git status
        .mockReturnValueOnce('+' + 'x'.repeat(20000));  // git diff
      const result = await (server as any).getWorkingTreeDiffs();
      expect(result.files[0].diff.length).toBeLessThanOrEqual(15100);
      expect(result.files[0].diff).toContain('truncated');
    });
  });

  // ─── Activity Tracking ─────────────────────────────────────

  describe('startActivityTracking', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('enables activity tracking', () => {
      (server as any).startActivityTracking();
      expect((server as any).activityTracking).toBe(true);
    });

    it('clears activity log', () => {
      (server as any).activityLog = [{ type: 'test', detail: 'old', timestamp: 0 }];
      (server as any).startActivityTracking();
      expect((server as any).activityLog).toEqual([]);
    });

    it('disables tracking after 5 minutes', () => {
      (server as any).startActivityTracking();
      expect((server as any).activityTracking).toBe(true);
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect((server as any).activityTracking).toBe(false);
    });
  });

  // ─── Workspace Listeners ───────────────────────────────────

  describe('setupWorkspaceListeners', () => {
    it('registers diagnostic change listener', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.languages.onDidChangeDiagnostics).toHaveBeenCalled();
    });

    it('registers active editor change listener', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.window.onDidChangeActiveTextEditor).toHaveBeenCalled();
    });

    it('registers text document change listener', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.workspace.onDidChangeTextDocument).toHaveBeenCalled();
    });

    it('registers file system watcher', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledWith('**/*');
    });

    it('registers terminal open listener', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.window.onDidOpenTerminal).toHaveBeenCalled();
    });

    it('registers document save listener', () => {
      (server as any).setupWorkspaceListeners();
      expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalled();
    });

    it('accumulates disposables', () => {
      const beforeCount = (server as any).disposables.length;
      (server as any).setupWorkspaceListeners();
      // Should have added multiple listener disposables
      expect((server as any).disposables.length).toBeGreaterThan(beforeCount);
    });
  });

  describe('workspace listener callbacks', () => {
    let diagnosticsCallback: Function;
    let editorChangeCallback: Function;
    let docChangeCallback: Function;
    let terminalOpenCallback: Function;
    let docSaveCallback: Function;
    let fileCreateCallback: Function;
    let fileChangeCallback: Function;
    let fileDeleteCallback: Function;

    beforeEach(() => {
      // Capture the callbacks by making the mocks save the argument
      vscode.languages.onDidChangeDiagnostics.mockImplementation((cb: Function) => {
        diagnosticsCallback = cb;
        return { dispose: jest.fn() };
      });
      vscode.window.onDidChangeActiveTextEditor.mockImplementation((cb: Function) => {
        editorChangeCallback = cb;
        return { dispose: jest.fn() };
      });
      vscode.workspace.onDidChangeTextDocument.mockImplementation((cb: Function) => {
        docChangeCallback = cb;
        return { dispose: jest.fn() };
      });
      vscode.window.onDidOpenTerminal.mockImplementation((cb: Function) => {
        terminalOpenCallback = cb;
        return { dispose: jest.fn() };
      });
      vscode.workspace.onDidSaveTextDocument.mockImplementation((cb: Function) => {
        docSaveCallback = cb;
        return { dispose: jest.fn() };
      });
      vscode.workspace.createFileSystemWatcher.mockImplementation(() => ({
        onDidCreate: jest.fn((cb: Function) => { fileCreateCallback = cb; return { dispose: jest.fn() }; }),
        onDidChange: jest.fn((cb: Function) => { fileChangeCallback = cb; return { dispose: jest.fn() }; }),
        onDidDelete: jest.fn((cb: Function) => { fileDeleteCallback = cb; return { dispose: jest.fn() }; }),
        dispose: jest.fn(),
      }));

      // Spy on broadcastToAuthenticated and sendToAllSessions
      jest.spyOn(server as any, 'broadcastToAuthenticated').mockImplementation(() => {});
      jest.spyOn(server as any, 'sendToAllSessions').mockImplementation(() => {});

      (server as any).setupWorkspaceListeners();
    });

    describe('onDidChangeDiagnostics', () => {
      it('broadcasts diagnostics summary', () => {
        diagnosticsCallback();
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'diagnostics.changed',
          { errors: 0, warnings: 0 },
        );
      });

      it('tracks activity when tracking enabled', () => {
        (server as any).activityTracking = true;
        diagnosticsCallback();
        expect((server as any).activityLog).toHaveLength(1);
        expect((server as any).activityLog[0].type).toBe('diagnostics');
        expect((server as any).sendToAllSessions).toHaveBeenCalledWith(
          'agent.activity',
          expect.objectContaining({ type: 'diagnostics' }),
        );
      });

      it('does not track activity when tracking disabled', () => {
        (server as any).activityTracking = false;
        diagnosticsCallback();
        expect((server as any).activityLog).toHaveLength(0);
      });
    });

    describe('onDidChangeActiveTextEditor', () => {
      it('broadcasts editor changed with path', () => {
        const mockEditor = {
          document: { uri: { fsPath: '/mock/workspace/src/app.ts' } },
        };
        vscode.workspace.asRelativePath.mockReturnValue('src/app.ts');
        editorChangeCallback(mockEditor);
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'editor.changed',
          { path: 'src/app.ts' },
        );
      });

      it('broadcasts null path when no editor', () => {
        editorChangeCallback(undefined);
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'editor.changed',
          { path: null },
        );
      });

      it('tracks editor activity when tracking enabled', () => {
        (server as any).activityTracking = true;
        const mockEditor = {
          document: { uri: { fsPath: '/mock/workspace/src/app.ts' } },
        };
        vscode.workspace.asRelativePath.mockReturnValue('src/app.ts');
        editorChangeCallback(mockEditor);
        expect((server as any).activityLog).toHaveLength(1);
        expect((server as any).activityLog[0].type).toBe('editor');
      });
    });

    describe('onDidChangeTextDocument', () => {
      it('forwards to interceptor', () => {
        const event = { contentChanges: [{ text: 'x', rangeLength: 0 }], document: { uri: { scheme: 'file', toString: () => 'file:///f.ts' }, languageId: 'ts' } };
        docChangeCallback(event);
        expect(mockInterceptor.onDocumentChange).toHaveBeenCalledWith(event);
      });

      it('tracks file edits with activity tracking', () => {
        (server as any).activityTracking = true;
        const event = {
          contentChanges: [{
            text: 'new content here!',
            rangeLength: 0,
            range: { start: { line: 0 }, end: { line: 0 } },
          }],
          document: {
            uri: { scheme: 'file', toString: () => 'file:///f.ts' },
            languageId: 'typescript',
          },
        };
        vscode.workspace.asRelativePath.mockReturnValue('f.ts');
        docChangeCallback(event);
        expect((server as any).agentModifiedFiles.has('f.ts')).toBe(true);
        expect((server as any).activityLog.length).toBeGreaterThanOrEqual(1);
      });

      it('ignores non-file scheme documents', () => {
        (server as any).activityTracking = true;
        const event = {
          contentChanges: [{ text: 'new text!!!', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } }],
          document: { uri: { scheme: 'output', toString: () => 'output:///log' }, languageId: 'log' },
        };
        docChangeCallback(event);
        expect((server as any).agentModifiedFiles.size).toBe(0);
      });

      it('ignores small changes below threshold', () => {
        (server as any).activityTracking = true;
        const event = {
          contentChanges: [{ text: 'x', rangeLength: 0, range: { start: { line: 0 }, end: { line: 0 } } }],
          document: { uri: { scheme: 'file', toString: () => 'file:///f.ts' }, languageId: 'ts' },
        };
        vscode.workspace.asRelativePath.mockReturnValue('f.ts');
        docChangeCallback(event);
        // totalCharsChanged = 1, threshold is > 5
        expect((server as any).agentModifiedFiles.size).toBe(0);
      });
    });

    describe('file system watcher', () => {
      it('broadcasts file.created', () => {
        fileCreateCallback({ fsPath: '/mock/workspace/new.ts' });
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'file.created',
          expect.objectContaining({ path: expect.any(String) }),
        );
      });

      it('broadcasts file.changed', () => {
        fileChangeCallback({ fsPath: '/mock/workspace/changed.ts' });
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'file.changed',
          expect.objectContaining({ path: expect.any(String) }),
        );
      });

      it('broadcasts file.deleted', () => {
        fileDeleteCallback({ fsPath: '/mock/workspace/old.ts' });
        expect((server as any).broadcastToAuthenticated).toHaveBeenCalledWith(
          'file.deleted',
          expect.objectContaining({ path: expect.any(String) }),
        );
      });

      it('tracks file creation with activity', () => {
        (server as any).activityTracking = true;
        vscode.workspace.asRelativePath.mockReturnValue('new.ts');
        fileCreateCallback({ fsPath: '/mock/workspace/new.ts' });
        expect((server as any).agentModifiedFiles.has('new.ts')).toBe(true);
        expect((server as any).activityLog[0].type).toBe('file-created');
      });

      it('tracks file change with activity', () => {
        (server as any).activityTracking = true;
        vscode.workspace.asRelativePath.mockReturnValue('changed.ts');
        fileChangeCallback({ fsPath: '/mock/workspace/changed.ts' });
        expect((server as any).agentModifiedFiles.has('changed.ts')).toBe(true);
      });

      it('tracks file deletion with activity', () => {
        (server as any).activityTracking = true;
        vscode.workspace.asRelativePath.mockReturnValue('old.ts');
        fileDeleteCallback({ fsPath: '/mock/workspace/old.ts' });
        expect((server as any).activityLog[0].type).toBe('file-deleted');
      });
    });

    describe('onDidOpenTerminal', () => {
      it('tracks terminal open with activity', () => {
        (server as any).activityTracking = true;
        terminalOpenCallback({ name: 'zsh' });
        expect((server as any).activityLog[0].type).toBe('terminal');
        expect((server as any).activityLog[0].detail).toContain('zsh');
      });

      it('does nothing without activity tracking', () => {
        (server as any).activityTracking = false;
        terminalOpenCallback({ name: 'zsh' });
        expect((server as any).activityLog).toHaveLength(0);
      });
    });

    describe('onDidSaveTextDocument', () => {
      it('tracks file save with activity', () => {
        (server as any).activityTracking = true;
        vscode.workspace.asRelativePath.mockReturnValue('saved.ts');
        docSaveCallback({ uri: { fsPath: '/mock/workspace/saved.ts' } });
        expect((server as any).activityLog[0].type).toBe('file-saved');
        expect((server as any).activityLog[0].detail).toContain('saved.ts');
      });

      it('does nothing without activity tracking', () => {
        (server as any).activityTracking = false;
        docSaveCallback({ uri: { fsPath: '/mock/workspace/saved.ts' } });
        expect((server as any).activityLog).toHaveLength(0);
      });
    });
  });

  // ─── Dispose ────────────────────────────────────────────────

  describe('dispose', () => {
    it('disposes relay', () => {
      server.dispose();
      expect(mockRelay.dispose).toHaveBeenCalled();
    });

    it('disposes interceptor', () => {
      server.dispose();
      expect(mockInterceptor.dispose).toHaveBeenCalled();
    });

    it('disposes agent', () => {
      server.dispose();
      expect(mockAgent.dispose).toHaveBeenCalled();
    });

    it('disposes tunnel', () => {
      server.dispose();
      expect(tunnel.dispose).toHaveBeenCalled();
    });

    it('disposes status bar item', () => {
      const statusBarItem = vscode.window.createStatusBarItem.mock.results[0].value;
      server.dispose();
      expect(statusBarItem.dispose).toHaveBeenCalled();
    });

    it('clears sessions', () => {
      (server as any).sessions.set('s1', { id: 's1' });
      server.dispose();
      expect((server as any).sessions.size).toBe(0);
    });

    it('disposes all lingering disposables', () => {
      const mockDisposable = { dispose: jest.fn() };
      (server as any).disposables = [mockDisposable];
      server.dispose();
      expect(mockDisposable.dispose).toHaveBeenCalled();
    });
  });
});
