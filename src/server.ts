import * as vscode from 'vscode';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import express = require('express');
import WebSocket = require('ws');
import { RpcHandler } from './rpc';
import { AuthManager } from './auth';
import { CopilotBridge } from './copilot';
import { ContextProvider } from './context';
import { AgentOperations } from './agent';
import { TunnelManager } from './tunnel';
import { ServerState, ChatMessage } from './types';
import { ChatResponseInterceptor } from './interceptor';

/** Tracks per-session state for message buffering across disconnects. */
interface SessionState {
  /** Current WebSocket, or null if disconnected. */
  ws: WebSocket | null;
  /** Messages queued while the phone was disconnected. */
  eventQueue: Array<{ method: string; data: any }>;
  /** Last agent response — accumulated during streaming so it can be replayed on reconnect. */
  lastAgentResponse: {
    content: string;
    complete: boolean;
    timestamp: number;
  } | null;
}

const MAX_EVENT_QUEUE_SIZE = 200;

/**
 * Main server — HTTP + WebSocket.
 * Serves the PWA, handles auth, routes RPC calls.
 */
export class MobileCopilotServer {
  private app: express.Express;
  private httpServer: http.Server | null = null;
  private wss: WebSocket.Server | null = null;
  private rpc: RpcHandler;
  private auth: AuthManager;
  private copilot: CopilotBridge;
  private contextProvider: ContextProvider;
  private agent: AgentOperations;
  private tunnel: TunnelManager;
  private outputChannel: vscode.LogOutputChannel;
  private clients: Map<WebSocket, { sessionId: string; authenticated: boolean }> = new Map();
  private sessions: Map<string, SessionState> = new Map();
  private port: number;
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private extensionContext: vscode.ExtensionContext;
  private interceptor: ChatResponseInterceptor;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.LogOutputChannel) {
    this.extensionContext = context;
    this.outputChannel = outputChannel;
    this.port = vscode.workspace.getConfiguration('mobileCopilot').get<number>('port', 3847);

    this.app = express();
    this.rpc = new RpcHandler();
    this.auth = new AuthManager(context);
    this.copilot = new CopilotBridge(outputChannel);
    this.contextProvider = new ContextProvider();
    this.agent = new AgentOperations(this.contextProvider, outputChannel);
    this.tunnel = new TunnelManager(outputChannel);
    this.interceptor = new ChatResponseInterceptor(outputChannel);

    // Status bar
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'mobile-copilot.showQR';
    this.updateStatusBar('stopped');

    this.setupExpress();
    this.setupRpcHandlers();
    this.setupWorkspaceListeners();
  }

  // ─── Server Lifecycle ───────────────────────────────────────────

  async start(): Promise<void> {
    if (this.httpServer) {
      vscode.window.showWarningMessage('Mobile Copilot server is already running.');
      return;
    }

    // Generate auth token
    await this.auth.generateToken();

    // Start HTTP server
    await new Promise<void>((resolve, reject) => {
      this.httpServer = this.app.listen(this.port, '0.0.0.0', () => {
        this.outputChannel.info(`Server started on port ${this.port}`);
        resolve();
      });
      this.httpServer.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.port} is already in use. Change mobileCopilot.port in settings.`));
        } else {
          reject(err);
        }
      });
    });

    // Setup WebSocket server
    this.wss = new WebSocket.Server({ server: this.httpServer! });
    this.setupWebSocket();

    // Try tunnel
    const config = vscode.workspace.getConfiguration('mobileCopilot');
    if (config.get<string>('tunnelProvider', 'none') !== 'none') {
      const tunnelUrl = await this.tunnel.startTunnel(this.port);
      if (tunnelUrl) {
        this.outputChannel.info(`Tunnel active: ${tunnelUrl}`);
      }
    }

    // Update status bar
    this.updateStatusBar('running');
    this.statusBarItem.show();

    // Show QR code
    await this.showQRCode();

    vscode.window.showInformationMessage(
      `Mobile Copilot server running on port ${this.port}. Scan the QR code to connect.`
    );
  }

  async stop(): Promise<void> {
    // Disconnect all clients
    for (const [ws] of this.clients) {
      ws.close(1000, 'Server shutting down');
    }
    this.clients.clear();

    // Stop tunnel
    this.tunnel.stopTunnel();

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    this.updateStatusBar('stopped');
    this.outputChannel.info('Server stopped');
    vscode.window.showInformationMessage('Mobile Copilot server stopped.');
  }

  async showQRCode(): Promise<void> {
    const baseUrl = this.getServerUrl();
    const pairingUrl = this.auth.getPairingUrl(baseUrl);
    await this.auth.showQRPanel(this.extensionContext, pairingUrl, baseUrl);
  }

  /**
   * Manually set a tunnel URL (e.g. from the Ports tab forwarded address).
   * Regenerates the QR code with the new URL.
   */
  async setTunnelUrl(url: string): Promise<void> {
    this.tunnel.setManualUrl(url.replace(/\/$/, ''));
    this.updateStatusBar('tunnel');
    await this.showQRCode();
    vscode.window.showInformationMessage(`QR code updated with tunnel URL: ${url}`);
  }

  async toggleTunnel(): Promise<void> {
    if (this.tunnel.isActive()) {
      this.tunnel.stopTunnel();
      this.updateStatusBar('running');
      vscode.window.showInformationMessage('Tunnel disconnected. LAN-only mode.');
    } else {
      const tunnelUrl = await this.tunnel.startTunnel(this.port);
      if (tunnelUrl) {
        this.updateStatusBar('tunnel');
        vscode.window.showInformationMessage(`Tunnel active: ${tunnelUrl}`);
        // Re-show QR with tunnel URL
        await this.showQRCode();
      } else {
        vscode.window.showErrorMessage('Failed to start tunnel. Check the output channel for details.');
      }
    }
  }

  getState(): ServerState {
    return {
      running: this.httpServer !== null,
      port: this.port,
      localUrl: `http://localhost:${this.port}`,
      externalUrl: this.getServerUrl(),
      tunnelUrl: this.tunnel.getTunnelUrl() || undefined,
      connectedClients: this.clients.size,
    };
  }

  // ─── Express Setup ──────────────────────────────────────────────

  private setupExpress(): void {
    // CORS for PWA
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
      }
      next();
    });

    this.app.use(express.json({ limit: '10mb' }));

    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ status: 'ok', version: '0.1.0', uptime: process.uptime() });
    });

    // Auth endpoint — validate pairing token
    this.app.get('/api/auth', async (req, res) => {
      const token = req.query.token as string;
      if (!token) {
        return res.status(400).json({ error: 'Token required' });
      }

      try {
        const valid = await this.auth.validateToken(token);
        if (valid) {
          const session = this.auth.createSession(req.get('user-agent'));
          res.json({ sessionId: session.id, success: true });
        } else {
          res.status(401).json({ error: 'Invalid token' });
        }
      } catch {
        res.status(401).json({ error: 'Invalid token' });
      }
    });

    // Pairing redirect — from QR code
    this.app.get('/pair', async (req, res) => {
      const token = req.query.token as string;
      if (!token) {
        return res.status(400).send('Missing token');
      }
      // Redirect to the PWA with the token
      res.redirect(`/?token=${encodeURIComponent(token)}`);
    });

    // Serve PWA static files
    const mobilePath = path.join(__dirname, 'mobile');
    if (fs.existsSync(mobilePath)) {
      // Disable caching for HTML/JS/CSS so updates propagate immediately
      this.app.use((req, res, next) => {
        if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
        next();
      });
      this.app.use(express.static(mobilePath, { etag: false }));

      // SPA fallback — serve index.html for unmatched routes
      this.app.get('*', (req, res) => {
        if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.sendFile(path.join(mobilePath, 'index.html'));
        }
      });
    }
  }

  // ─── WebSocket Setup ────────────────────────────────────────────

  private setupWebSocket(): void {
    if (!this.wss) return;

    this.wss.on('connection', (ws, req) => {
      this.outputChannel.info(`WebSocket connection from ${req.socket.remoteAddress}`);

      // Client starts unauthenticated
      this.clients.set(ws, { sessionId: '', authenticated: false });

      ws.on('message', async (data) => {
        const raw = data.toString();
        const clientInfo = this.clients.get(ws);

        if (!clientInfo) {
          ws.close(4001, 'Unknown client');
          return;
        }

        // First message must be auth
        if (!clientInfo.authenticated) {
          try {
            const msg = JSON.parse(raw);
            if (msg.method === 'auth' && msg.params?.sessionId) {
              const valid = this.auth.validateSession(msg.params.sessionId);
              if (valid) {
                clientInfo.authenticated = true;
                clientInfo.sessionId = msg.params.sessionId;
                this.registerSession(msg.params.sessionId, ws);
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: msg.params.sessionId });
                this.flushSessionQueue(msg.params.sessionId);
                this.updateStatusBar('connected');
                this.outputChannel.info(`Client authenticated: ${msg.params.sessionId}`);
                return;
              }
            }
            // Also support token-based direct auth
            if (msg.method === 'auth' && msg.params?.token) {
              const valid = await this.auth.validateToken(msg.params.token);
              if (valid) {
                const session = this.auth.createSession();
                clientInfo.authenticated = true;
                clientInfo.sessionId = session.id;
                this.registerSession(session.id, ws);
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: session.id });
                this.flushSessionQueue(session.id);
                this.updateStatusBar('connected');
                this.outputChannel.info(`Client authenticated via token: ${session.id}`);
                return;
              }
            }

            this.rpc.sendEvent(ws, 'auth.failed', { error: 'Invalid credentials' });
            ws.close(4003, 'Authentication failed');
          } catch {
            ws.close(4002, 'Invalid message format');
          }
          return;
        }

        // Authenticated — route to RPC handler
        await this.rpc.handleMessage(ws, raw);
      });

      ws.on('close', () => {
        const clientInfo = this.clients.get(ws);
        // Do NOT remove the session on disconnect — keep it alive so the
        // phone can reconnect with the same sessionId without re-scanning
        // the QR code. Sessions expire naturally via sessionTimeoutSec.
        this.clients.delete(ws);

        // Mark session as disconnected but keep the state (queue, last response)
        if (clientInfo?.sessionId) {
          const session = this.sessions.get(clientInfo.sessionId);
          if (session) {
            session.ws = null;
            this.outputChannel.info(`[Session] ${clientInfo.sessionId} — socket closed, buffering enabled`);
          }
        }

        this.updateStatusBar(this.clients.size > 0 ? 'connected' : 'running');
        this.outputChannel.info(`Client disconnected (session ${clientInfo?.sessionId || 'none'} preserved)`);
      });

      ws.on('error', (err) => {
        this.outputChannel.error(`WebSocket error: ${err.message}`);
      });

      // Send connection ID (unauthenticated at this point)
      this.rpc.sendEvent(ws, 'connection.ready', {
        serverVersion: '0.1.0',
        requiresAuth: true,
      });
    });
  }

  // ─── RPC Handlers ───────────────────────────────────────────────

  private setupRpcHandlers(): void {
    // ── Chat / Copilot ──

    // AGENT MODE — configurable capture strategy.
    // captureMode setting controls how the response is captured:
    //   "relay"       — augmented prompt + relay file (deterministic, proven)
    //   "interceptor" — document change monitoring (experimental)
    //   "hybrid"      — interceptor first, relay fallback
    this.rpc.onStream('chat.sendToAgent', async (params, rawSend, ws) => {
      const { prompt } = params as { prompt: string };
      this.outputChannel.info(`[Agent] Received prompt from mobile: "${prompt?.substring(0, 80)}"`);

      if (!prompt || !prompt.trim()) {
        throw new Error('Prompt is required');
      }

      // Wrap send() with session-aware buffering — if the phone disconnects
      // mid-stream, chunks accumulate and replay on reconnect.
      const send = this.createSessionAwareSend(ws, rawSend);

      // Reset modified file tracking for this agent run
      this.agentModifiedFiles.clear();

      // Emit agent.status → started
      this.sendToAllSessions('agent.status', { status: 'running', timestamp: Date.now() });

      // Start tracking agent activity
      this.startActivityTracking();

      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        this.sendToAllSessions('agent.status', { status: 'failed', error: 'No workspace folder open', timestamp: Date.now() });
        throw new Error('No workspace folder open');
      }

      try {
        const config = vscode.workspace.getConfiguration('mobileCopilot');
        const captureMode = config.get<string>('captureMode', 'relay');
        this.outputChannel.info(`[Agent] Capture mode: ${captureMode}`);

        // Always start the interceptor for URI logging and file-change tracking
        const interceptorSession = this.interceptor.startSession((chunk) => {
          // Only stream interceptor chunks if we're in interceptor or hybrid mode
          if (captureMode === 'interceptor' || captureMode === 'hybrid') {
            send(chunk);
          }
        });

        if (captureMode === 'relay' || captureMode === 'hybrid') {
          await this.runRelayCapture(prompt, wsFolder, send, captureMode === 'hybrid' ? interceptorSession : null);
        } else {
          await this.runInterceptorCapture(prompt, send, interceptorSession);
        }

        // Mark the response as complete so reconnect replay works
        this.markAgentResponseComplete(ws);

        // Compute per-file diffs for the mobile UI
        const fileDiffs = await this.computeFileDiffs();

        // Emit agent.status → completed with modified files and diffs
        this.sendToAllSessions('agent.status', {
          status: 'completed',
          modifiedFiles: Array.from(this.agentModifiedFiles),
          diffs: fileDiffs,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        const fileDiffs = await this.computeFileDiffs();
        this.sendToAllSessions('agent.status', {
          status: 'failed',
          error: err.message || 'Agent error',
          modifiedFiles: Array.from(this.agentModifiedFiles),
          diffs: fileDiffs,
          timestamp: Date.now(),
        });
        throw err;
      }
    });

    // STREAMING MODE — uses vscode.lm API for raw LLM chat (no tools/agent).
    this.rpc.onStream('chat.send', async (params, send, _ws) => {
      this.outputChannel.info(`[Chat] Received chat.send from mobile`);
      const { prompt, history, context, model } = params as {
        prompt: string;
        history?: ChatMessage[];
        context?: any[];
        model?: string;
      };

      this.outputChannel.info(`[Chat] Prompt: "${prompt?.substring(0, 80)}"`);

      // Optionally select a different model
      if (model) {
        await this.copilot.selectModel(model);
      }

      // Build context from workspace if not provided
      const resolvedContext = context || await this.contextProvider.buildPromptContext();

      await this.copilot.sendPrompt(
        prompt,
        history || [],
        resolvedContext,
        (chunk) => send(chunk)
      );
    });

    this.rpc.onRequest('chat.models', async () => {
      return this.copilot.listModels();
    });

    this.rpc.onRequest('chat.tokenCount', async (params) => {
      return { count: await this.copilot.countTokens(params.text) };
    });

    // ── Workspace Info ──
    this.rpc.onRequest('workspace.info', async () => {
      return this.agent.getWorkspaceInfo();
    });

    this.rpc.onRequest('workspace.fileTree', async (params) => {
      return this.agent.getFileTree(params?.maxDepth);
    });

    this.rpc.onRequest('workspace.listDir', async (params) => {
      return this.agent.listDirectory(params.path);
    });

    // ── File Operations ──
    this.rpc.onRequest('file.read', async (params) => {
      return this.agent.readFile(params);
    });

    this.rpc.onRequest('file.write', async (params) => {
      return this.agent.writeFile(params);
    });

    this.rpc.onRequest('file.create', async (params) => {
      return this.agent.createFile(params);
    });

    this.rpc.onRequest('file.delete', async (params) => {
      return this.agent.deleteFile(params);
    });

    this.rpc.onRequest('file.edit', async (params) => {
      return this.agent.editFile(params);
    });

    this.rpc.onRequest('file.search', async (params) => {
      return this.agent.searchFiles(params);
    });

    // ── Terminal ──
    this.rpc.onRequest('terminal.run', async (params) => {
      return this.agent.runCommand(params);
    });

    this.rpc.onRequest('terminal.list', async () => {
      return this.agent.getTerminals();
    });

    // ── Editor ──
    this.rpc.onRequest('editor.open', async (params) => {
      return this.agent.openFile(params);
    });

    this.rpc.onRequest('editor.active', async () => {
      return this.agent.getActiveEditor();
    });

    // ── Diagnostics ──
    this.rpc.onRequest('diagnostics.all', async () => {
      return this.agent.getDiagnostics();
    });

    this.rpc.onRequest('diagnostics.summary', async () => {
      return this.agent.getDiagnosticsSummary();
    });

    // ── Git ──
    this.rpc.onRequest('git.status', async () => {
      return this.agent.getGitStatus();
    });

    this.rpc.onRequest('git.diff', async () => {
      return this.agent.gitDiff();
    });

    // Return all uncommitted changes with per-file unified diffs
    this.rpc.onRequest('git.changedFiles', async () => {
      return this.getWorkingTreeDiffs();
    });

    // Revert specific files (or all uncommitted changes)
    this.rpc.onRequest('git.restoreFiles', async (params) => {
      const files = params?.files as string[];
      if (!files || files.length === 0) {
        return { restored: 0, message: 'No files specified' };
      }
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) throw new Error('No workspace folder open');

      const { execSync } = require('child_process');
      const results: string[] = [];
      for (const filePath of files) {
        try {
          // Check if it's an untracked file (needs rm, not restore)
          const status = execSync(`git status --porcelain -- "${filePath}"`, {
            cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
          }).trim();
          if (status.startsWith('??')) {
            execSync(`rm -f "${filePath}"`, { cwd: wsFolder.uri.fsPath });
          } else {
            execSync(`git restore "${filePath}"`, { cwd: wsFolder.uri.fsPath });
            // Also unstage if staged
            try { execSync(`git restore --staged "${filePath}"`, { cwd: wsFolder.uri.fsPath }); } catch { /* ignore */ }
          }
          results.push(filePath);
        } catch (err: any) {
          this.outputChannel.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
        }
      }
      return { restored: results.length, files: results };
    });

    // Selectively revert specific diff hunks from a file
    this.rpc.onRequest('git.revertHunks', async (params) => {
      const filePath = params?.filePath as string;
      const hunkIndices = params?.hunkIndices as number[];
      const fullDiff = params?.diff as string;

      if (!filePath || !hunkIndices?.length || !fullDiff) {
        return { success: false, message: 'Missing required parameters (filePath, hunkIndices, diff)' };
      }

      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) throw new Error('No workspace folder open');

      const { execSync } = require('child_process');
      const fs = require('fs');
      const nodePath = require('path');
      const os = require('os');

      // Parse the unified diff into header lines + individual hunks
      const lines = fullDiff.split('\n');
      const headerLines: string[] = [];
      const hunks: { header: string; lines: string[] }[] = [];
      let currentHunk: { header: string; lines: string[] } | null = null;

      for (const line of lines) {
        if (line.startsWith('@@')) {
          if (currentHunk) hunks.push(currentHunk);
          currentHunk = { header: line, lines: [] };
        } else if (currentHunk) {
          currentHunk.lines.push(line);
        } else {
          headerLines.push(line);
        }
      }
      if (currentHunk) hunks.push(currentHunk);

      // Ensure we have a valid diff --git header for git apply
      if (!headerLines.some(l => l.startsWith('diff --git'))) {
        headerLines.unshift(`diff --git a/${filePath} b/${filePath}`);
      }
      if (!headerLines.some(l => l.startsWith('---'))) {
        headerLines.push(`--- a/${filePath}`);
      }
      if (!headerLines.some(l => l.startsWith('+++'))) {
        headerLines.push(`+++ b/${filePath}`);
      }

      // Build a patch containing only the hunks to revert
      const patchLines = [...headerLines];
      for (const idx of hunkIndices) {
        if (idx >= 0 && idx < hunks.length) {
          patchLines.push(hunks[idx].header);
          patchLines.push(...hunks[idx].lines);
        }
      }

      const tmpFile = nodePath.join(os.tmpdir(), `mobile-copilot-revert-${Date.now()}.patch`);
      fs.writeFileSync(tmpFile, patchLines.join('\n') + '\n');

      try {
        execSync(`git apply --reverse "${tmpFile}"`, {
          cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
        });
        return { success: true, reverted: hunkIndices.length };
      } catch (err: any) {
        // Fallback: try with --3way for better conflict handling
        try {
          execSync(`git apply --reverse --3way "${tmpFile}"`, {
            cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
          });
          return { success: true, reverted: hunkIndices.length };
        } catch (err2: any) {
          this.outputChannel.warn(`[Git] revertHunks failed for ${filePath}: ${err2.message}`);
          return { success: false, message: `Failed to revert hunks: ${err2.message}` };
        }
      } finally {
        try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    // Revert agent changes — restores files modified during last agent run
    this.rpc.onRequest('git.restoreChanges', async (params) => {
      const files = params?.files as string[] | undefined;
      const filesToRestore = files && files.length > 0
        ? files
        : Array.from(this.agentModifiedFiles);

      if (filesToRestore.length === 0) {
        return { restored: 0, message: 'No modified files to restore' };
      }

      // Use git restore for each file
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) throw new Error('No workspace folder open');

      const results: string[] = [];
      for (const filePath of filesToRestore) {
        try {
          const { execSync } = require('child_process');
          execSync(`git restore "${filePath}"`, { cwd: wsFolder.uri.fsPath });
          results.push(filePath);
        } catch (err: any) {
          this.outputChannel.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
        }
      }

      this.agentModifiedFiles.clear();
      this.outputChannel.info(`[Git] Restored ${results.length} files`);
      return { restored: results.length, files: results };
    });

    // Get list of files modified by the last agent run
    this.rpc.onRequest('agent.modifiedFiles', async () => {
      return { files: Array.from(this.agentModifiedFiles) };
    });

    // ── Server State ──
    this.rpc.onRequest('server.state', async () => {
      return this.getState();
    });

    // ── Ping ──
    this.rpc.onRequest('ping', async () => {
      return { pong: true, timestamp: Date.now() };
    });
  }

  // ─── Capture Strategies ─────────────────────────────────────────

  /**
   * Find the last "safe" break point — end of a complete sentence, paragraph,
   * or code block — so we never stream a half-finished thought to mobile.
   * Returns the index (exclusive) up to which the content is safe to send.
   */
  private findSafeBreak(text: string): number {
    if (text.length === 0) return 0;

    const lastFenceClose = text.lastIndexOf('\n```\n');
    const lastDoubleLF = text.lastIndexOf('\n\n');
    const lastSentenceEnd = Math.max(
      text.lastIndexOf('. '),
      text.lastIndexOf('.\n'),
      text.lastIndexOf('!\n'),
      text.lastIndexOf('?\n'),
      text.lastIndexOf(':\n'),
    );
    const breakIdx = Math.max(lastDoubleLF, lastFenceClose, lastSentenceEnd);

    if (breakIdx <= 0) return 0;

    if (text[breakIdx] === '\n' && breakIdx + 1 < text.length && text[breakIdx + 1] === '\n') {
      return breakIdx + 2;
    }
    if (text[breakIdx] === '\n') return breakIdx + 1;
    return breakIdx + 2;
  }

  /**
   * RELAY CAPTURE — the proven, deterministic approach.
   * Augments the prompt with an instruction for Copilot to write its response
   * incrementally to a relay file. 5-second polling reads new content and
   * streams only complete thoughts (sentences/paragraphs) to mobile.
   */
  private async runRelayCapture(
    prompt: string,
    wsFolder: vscode.WorkspaceFolder,
    send: (chunk: string) => void,
    hybridInterceptorSession: { wait: () => Promise<any> } | null,
  ): Promise<void> {
    const RELAY_FILENAME = '.copilot-mobile-relay.md';
    const relayUri = vscode.Uri.joinPath(wsFolder.uri, RELAY_FILENAME);
    const DONE_MARKER = '<!-- MOBILE_DONE -->';
    const TIMEOUT_MS = 180_000;
    const POLL_INTERVAL_MS = 5_000;
    const IDLE_TIMEOUT_MS = 15_000;

    // Delete relay file if it exists
    try {
      await vscode.workspace.fs.delete(relayUri);
    } catch { /* ignore if it doesn't exist */ }

    // The relay file instruction is handled by .github/copilot-instructions.md
    // (injected as system context by VS Code). No prompt augmentation needed.

    // Watch for relay file changes and stream content to mobile
    let sentLength = 0;
    let lastContent = '';
    let hasReceivedContent = false;

    const relayPromise = new Promise<string>((resolve, reject) => {
      let resolved = false;

      // ── Absolute timeout — safety net ──
      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          clearInterval(pollTimer);
          watcher.dispose();
          if (lastContent.length > 0) {
            resolve(lastContent);
          } else {
            reject(new Error(
              'Copilot did not write the relay file within 3 minutes. ' +
              'The response may still be visible in the Chat panel on your desktop.'
            ));
          }
        }
      }, TIMEOUT_MS);

      // ── Idle timeout — finalize when no new content arrives ──
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (!hasReceivedContent) return;
        idleTimer = setTimeout(async () => {
          if (resolved) return;
          try {
            const finalBytes = await vscode.workspace.fs.readFile(relayUri);
            const finalContent = Buffer.from(finalBytes).toString('utf8').trim();
            if (finalContent.length > sentLength) {
              const remaining = finalContent.substring(sentLength).replace(DONE_MARKER, '').trimEnd();
              if (remaining.length > 0) send(remaining);
              lastContent = finalContent.replace(DONE_MARKER, '').trimEnd();
              sentLength = finalContent.length;
            }
          } catch { /* ignore */ }
          resolved = true;
          clearTimeout(timeoutTimer);
          clearInterval(pollTimer);
          watcher.dispose();
          this.outputChannel.info('[Relay] Idle timeout — assuming done');
          resolve(lastContent);
        }, IDLE_TIMEOUT_MS);
      };

      // ── Core: read file, find safe break, stream only complete thoughts ──
      const checkFile = async () => {
        if (resolved) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(relayUri);
          const content = Buffer.from(bytes).toString('utf8').trim();

          if (content.length === 0) return;
          this.outputChannel.info(`[Relay] Poll: file ${content.length} chars, sent ${sentLength}`);

          // Check for DONE marker → flush everything
          if (content.includes(DONE_MARKER)) {
            const finalText = content.replace(DONE_MARKER, '').trimEnd();
            if (finalText.length > sentLength) {
              send(finalText.substring(sentLength));
            }
            lastContent = finalText;
            resolved = true;
            clearTimeout(timeoutTimer);
            if (idleTimer) clearTimeout(idleTimer);
            clearInterval(pollTimer);
            watcher.dispose();
            this.outputChannel.info('[Relay] DONE marker detected');
            resolve(lastContent);
            return;
          }

          if (content.length <= sentLength) return;

          hasReceivedContent = true;
          resetIdleTimer();

          // Only send up to the last safe break (complete sentence/paragraph)
          const newContent = content.substring(sentLength);
          const safeIdx = this.findSafeBreak(newContent);

          if (safeIdx > 0) {
            const safeChunk = newContent.substring(0, safeIdx);
            send(safeChunk);
            sentLength += safeIdx;
            lastContent = content.substring(0, sentLength);
            this.outputChannel.info(`[Relay] Streamed ${safeChunk.length} chars (safe break). Total sent: ${sentLength}`);
          } else {
            this.outputChannel.info(`[Relay] No safe break in ${newContent.length} new chars — holding`);
          }
        } catch (err: any) {
          this.outputChannel.warn(`[Relay] Error reading file: ${err.message}`);
        }
      };

      // ── File watcher — react to file changes but throttle ──
      const pattern = new vscode.RelativePattern(wsFolder, RELAY_FILENAME);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      let lastWatcherCheck = 0;
      const throttledCheck = () => {
        const now = Date.now();
        if (now - lastWatcherCheck < 2_000) return;
        lastWatcherCheck = now;
        checkFile();
      };
      watcher.onDidChange(throttledCheck);
      watcher.onDidCreate(throttledCheck);

      // ── Poll every 5 seconds as the primary streaming mechanism ──
      const pollTimer = setInterval(checkFile, POLL_INTERVAL_MS);
    });

    // Inject prompt into native Copilot Chat panel
    this.outputChannel.info('[Relay] Injecting prompt into Copilot Chat...');
    send('⏳ *Waiting for Copilot agent response on desktop...*\n\n');

    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
      isPartialQuery: false,
    }).then(
      () => this.outputChannel.info('[Relay] Chat panel command executed'),
      (err: any) => this.outputChannel.error(`[Relay] Failed to open Chat panel: ${err.message}`)
    );

    // Wait for relay file
    try {
      const fullText = await relayPromise;
      this.outputChannel.info(`[Relay] Complete — ${fullText.length} chars sent to mobile.`);
      try { await vscode.workspace.fs.delete(relayUri); } catch { /* ignore */ }
    } catch (err: any) {
      this.outputChannel.error(`[Relay] Error: ${err.message}`);

      // HYBRID MODE: if relay failed and interceptor is running, wait for it
      if (hybridInterceptorSession) {
        this.outputChannel.info('[Hybrid] Relay failed, checking interceptor results...');
        try {
          const interceptResult = await hybridInterceptorSession.wait();
          if (interceptResult.capturedText.length > 0) {
            this.outputChannel.info(`[Hybrid] Interceptor captured ${interceptResult.capturedText.length} chars`);
            // Already streamed via interceptor callback
          } else if (interceptResult.fileChanges.length > 0) {
            const summary = interceptResult.fileChanges
              .map((fc: any) => `• **${fc.path}** — ${fc.linesAdded} added, ${fc.linesRemoved} removed`)
              .join('\n');
            send(`\n\n📁 **Agent modified files:**\n${summary}`);
          } else {
            send(`\n\n⚠️ ${err.message}`);
          }
        } catch {
          send(`\n\n⚠️ ${err.message}`);
        }
      } else {
        send(`\n\n⚠️ ${err.message}`);
      }
    }

    // In hybrid mode, also log interceptor findings (don't block on it)
    if (hybridInterceptorSession) {
      hybridInterceptorSession.wait().then((result: any) => {
        this.outputChannel.info(
          `[Hybrid] Interceptor session completed. Schemes: [${Array.from(result.schemesSeen).join(', ')}]. ` +
          `URIs: ${result.documentUris.length}. File changes: ${result.fileChanges.length}.`
        );
      }).catch(() => { /* ignore */ });
    }
  }

  /**
   * INTERCEPTOR CAPTURE — experimental, no prompt pollution.
   * Monitors document changes and workspace activity to detect the response.
   * Less reliable for text-only responses (no file changes).
   */
  private async runInterceptorCapture(
    prompt: string,
    send: (chunk: string) => void,
    interceptorSession: { wait: () => Promise<any> },
  ): Promise<void> {
    // Inject the RAW prompt — no augmented instructions
    this.outputChannel.info('[Interceptor] Injecting raw prompt into Copilot Chat...');
    send('⏳ *Sending to Copilot agent...*\n\n');

    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
      isPartialQuery: false,
    }).then(
      () => this.outputChannel.info('[Interceptor] Chat panel command executed'),
      (err: any) => this.outputChannel.error(`[Interceptor] Failed to open Chat panel: ${err.message}`)
    );

    // Wait for interceptor to detect completion via debounce
    try {
      const result = await interceptorSession.wait();
      this.outputChannel.info(
        `[Interceptor] Session complete — detected ${result.documentUris.length} document URIs, ` +
        `${result.fileChanges.length} file changes, captured ${result.capturedText.length} chars`
      );

      // If we captured chat text, it was already streamed via chunks.
      // If not, send a summary of what the agent did.
      if (result.capturedText.length === 0 && result.fileChanges.length > 0) {
        const summary = result.fileChanges
          .map((fc: any) => `• **${fc.path}** — ${fc.linesAdded} added, ${fc.linesRemoved} removed`)
          .join('\n');
        send(`\n\n📁 **Agent modified files:**\n${summary}`);
      } else if (result.capturedText.length === 0 && result.fileChanges.length === 0) {
        send('\n\n⚠️ Could not capture Copilot response. Check the Chat panel on your desktop.');
      }
    } catch (err: any) {
      this.outputChannel.error(`[Interceptor] Error: ${err.message}`);
      send(`\n\n⚠️ ${err.message}`);
    }
  }

  // ─── Workspace Event Listeners ──────────────────────────────────

  private setupWorkspaceListeners(): void {
    // Diagnostics changes
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        const summary = this.contextProvider.getDiagnosticsSummary();
        this.broadcastToAuthenticated('diagnostics.changed', summary);

        // Agent activity tracking
        if (this.activityTracking) {
          const activity = {
            type: 'diagnostics',
            detail: `Diagnostics updated: ${summary.errors} errors, ${summary.warnings} warnings`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );

    // Active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const filePath = editor
          ? vscode.workspace.asRelativePath(editor.document.uri)
          : null;
        this.broadcastToAuthenticated('editor.changed', { path: filePath });

        if (this.activityTracking && filePath) {
          const activity = {
            type: 'editor',
            detail: `Opened: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );

    // Text document changes (agent editing files) — with diff data
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        // Log ALL document URIs for debugging chat response detection
        if (e.contentChanges.length > 0) {
          console.log(`[DocChange] URI: ${e.document.uri.toString()} scheme=${e.document.uri.scheme} lang=${e.document.languageId} changes=${e.contentChanges.length}`);
          this.outputChannel.info(`[DocChange] ${e.document.uri.toString()} (scheme=${e.document.uri.scheme}, lang=${e.document.languageId})`);
        }

        // Feed into the interceptor if a session is active
        this.interceptor.onDocumentChange(e);

        if (this.activityTracking && e.contentChanges.length > 0) {
          const uri = e.document.uri;
          // Skip non-file schemes (git, untitled, vscode-*, etc.) for activity tracking
          if (uri.scheme !== 'file') return;

          const filePath = vscode.workspace.asRelativePath(uri);
          // Debounce: don't send for every keystroke, only meaningful edits
          const totalCharsChanged = e.contentChanges.reduce(
            (sum, c) => sum + c.text.length + c.rangeLength, 0
          );
          if (totalCharsChanged > 5) {
            // Track this file as modified by the agent
            this.agentModifiedFiles.add(filePath);

            // Compute structured diff info
            let linesAdded = 0;
            let linesRemoved = 0;
            const changeDetails: Array<{ range: string; preview: string }> = [];

            for (const change of e.contentChanges) {
              const newLines = change.text.split('\n').length - 1;
              const oldLines = change.range.end.line - change.range.start.line;
              linesAdded += newLines;
              linesRemoved += oldLines;

              // Preview of the change (truncated)
              const preview = change.text.length > 200
                ? change.text.substring(0, 200) + '...'
                : change.text;
              changeDetails.push({
                range: `L${change.range.start.line + 1}-L${change.range.end.line + 1}`,
                preview,
              });
            }

            const activity = {
              type: 'edit',
              detail: `Editing: ${filePath} (+${linesAdded} -${linesRemoved})`,
              timestamp: Date.now(),
              diff: {
                path: filePath,
                linesAdded,
                linesRemoved,
                changes: changeDetails.slice(0, 5), // Limit to 5 changes per event
              },
            };
            this.activityLog.push(activity);
            this.sendToAllSessions('agent.activity', activity);
          }
        }
      })
    );

    // File changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher.onDidCreate((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.created', { path: filePath });

        if (this.activityTracking) {
          this.agentModifiedFiles.add(filePath);
          const activity = {
            type: 'file-created',
            detail: `Created: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher.onDidChange((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.changed', { path: filePath });

        if (this.activityTracking) {
          this.agentModifiedFiles.add(filePath);
          const activity = {
            type: 'file-changed',
            detail: `Modified: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher.onDidDelete((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.deleted', { path: filePath });

        if (this.activityTracking) {
          const activity = {
            type: 'file-deleted',
            detail: `Deleted: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher
    );

    // Terminal activity (detects when Copilot runs terminal commands)
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.activityTracking) {
          const activity = {
            type: 'terminal',
            detail: `Terminal opened: ${terminal.name}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );

    // Document save events
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.activityTracking) {
          const filePath = vscode.workspace.asRelativePath(doc.uri);
          const activity = {
            type: 'file-saved',
            detail: `Saved: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private broadcastToAuthenticated(method: string, data: any): void {
    const authenticatedClients = new Set<WebSocket>();
    for (const [ws, info] of this.clients) {
      if (info.authenticated && ws.readyState === WebSocket.OPEN) {
        authenticatedClients.add(ws);
      }
    }
    this.rpc.broadcastEvent(authenticatedClients, method, data);
  }

  private getServerUrl(): string {
    const tunnelUrl = this.tunnel.getTunnelUrl();
    if (tunnelUrl) return tunnelUrl;

    // Get local IP for LAN access
    const interfaces = require('os').networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return `http://${iface.address}:${this.port}`;
        }
      }
    }

    return `http://localhost:${this.port}`;
  }

  private updateStatusBar(state: 'stopped' | 'running' | 'connected' | 'tunnel'): void {
    switch (state) {
      case 'stopped':
        this.statusBarItem.text = '$(device-mobile) Mobile: Off';
        this.statusBarItem.tooltip = 'Click to start Mobile Copilot';
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'running':
        this.statusBarItem.text = '$(broadcast) Mobile: LAN';
        this.statusBarItem.tooltip = `Mobile Copilot on port ${this.port}\nClick to show QR code`;
        this.statusBarItem.backgroundColor = undefined;
        break;
      case 'connected':
        this.statusBarItem.text = `$(broadcast) Mobile: ${this.clients.size} connected`;
        this.statusBarItem.tooltip = `${this.clients.size} device(s) connected\nClick to show QR code`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        break;
      case 'tunnel':
        this.statusBarItem.text = '$(globe) Mobile: Tunnel';
        this.statusBarItem.tooltip = `Tunnel active: ${this.tunnel.getTunnelUrl()}\nClick to show QR code`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }
    this.statusBarItem.show();
  }

  private activityTracking = false;
  private activityLog: Array<{ type: string; detail: string; timestamp: number }> = [];
  private agentModifiedFiles: Set<string> = new Set();

  /**
   * Start tracking workspace changes as "agent activity".
   * When a prompt is sent to Copilot Chat via passthrough, the agent
   * will make file changes, run commands, etc. We monitor those and
   * broadcast them to the mobile client as an activity feed.
   */
  private startActivityTracking(): void {
    this.activityTracking = true;
    this.activityLog = [];

    // Auto-stop tracking after 5 minutes (agent timeout)
    setTimeout(() => {
      this.activityTracking = false;
    }, 5 * 60 * 1000);
  }

  // ─── Session-aware message buffering ──────────────────────────

  /**
   * Register or update a session's WebSocket binding.
   * Called on every successful authentication (including reconnects).
   */
  private registerSession(sessionId: string, ws: WebSocket): void {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { ws, eventQueue: [], lastAgentResponse: null };
      this.sessions.set(sessionId, session);
      this.outputChannel.info(`[Session] Created new session state: ${sessionId}`);
    } else {
      session.ws = ws;
      this.outputChannel.info(`[Session] Reconnected session: ${sessionId} (${session.eventQueue.length} queued events)`);
    }
  }

  /**
   * Flush queued events to the client after reconnection.
   * Also sends `session.missedResponse` if there's a completed agent response.
   */
  private flushSessionQueue(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    // Replay queued events
    if (session.eventQueue.length > 0) {
      this.outputChannel.info(`[Session] Flushing ${session.eventQueue.length} queued events for ${sessionId}`);
      for (const { method, data } of session.eventQueue) {
        this.rpc.sendEvent(session.ws, method, data);
      }
      session.eventQueue = [];
    }

    // Replay missed agent response
    if (session.lastAgentResponse && session.lastAgentResponse.content.length > 0) {
      this.outputChannel.info(
        `[Session] Replaying missed agent response (${session.lastAgentResponse.content.length} chars, ` +
        `complete=${session.lastAgentResponse.complete}) for ${sessionId}`
      );
      this.rpc.sendEvent(session.ws, 'session.missedResponse', {
        content: session.lastAgentResponse.content,
        complete: session.lastAgentResponse.complete,
        timestamp: session.lastAgentResponse.timestamp,
      });
      // Clear after replay so it's not sent again
      if (session.lastAgentResponse.complete) {
        session.lastAgentResponse = null;
      }
    }
  }

  /**
   * Queue an event for a specific session. Used when the phone is disconnected
   * but the server has messages to deliver.
   */
  private queueForSession(sessionId: string, method: string, data: any): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.eventQueue.length >= MAX_EVENT_QUEUE_SIZE) {
      // Drop oldest to prevent unbounded growth
      session.eventQueue.shift();
    }
    session.eventQueue.push({ method, data });
  }

  /**
   * Send an event to all authenticated sessions — either directly or queued.
   * Replaces broadcastToAuthenticated for session-aware delivery.
   */
  private sendToAllSessions(method: string, data: any): void {
    // Send to connected clients directly
    this.broadcastToAuthenticated(method, data);

    // Queue for disconnected sessions
    for (const [sessionId, session] of this.sessions) {
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
        this.queueForSession(sessionId, method, data);
      }
    }
  }

  /**
   * Create a session-aware `send` callback for streaming responses.
   * If the phone disconnects mid-stream, chunks are accumulated in
   * the session's `lastAgentResponse` and replayed on reconnect.
   */
  private createSessionAwareSend(
    originalWs: WebSocket,
    originalSend: (chunk: string) => void,
  ): (chunk: string) => void {
    // Find the sessionId for this socket
    const clientInfo = this.clients.get(originalWs);
    const sessionId = clientInfo?.sessionId;

    if (!sessionId) {
      // No session tracking — fall back to direct send
      return originalSend;
    }

    // Initialize the response buffer
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastAgentResponse = { content: '', complete: false, timestamp: Date.now() };
    }

    return (chunk: string) => {
      const sess = this.sessions.get(sessionId);
      if (sess?.lastAgentResponse) {
        sess.lastAgentResponse.content += chunk;
        sess.lastAgentResponse.timestamp = Date.now();
      }

      // Try direct send — if socket is open, it works; if not, accumulated in buffer
      if (originalWs.readyState === WebSocket.OPEN) {
        originalSend(chunk);
      } else {
        this.outputChannel.info(`[Session] Buffering ${chunk.length} chars for disconnected session ${sessionId}`);
      }
    };
  }

  /**
   * Compute per-file unified diffs for all files modified by the agent.
   * Returns an array of { path, diff } objects with the git diff output.
   */
  private async computeFileDiffs(): Promise<Array<{ path: string; diff: string }>> {
    const files = Array.from(this.agentModifiedFiles);
    if (files.length === 0) return [];

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return [];

    const results: Array<{ path: string; diff: string }> = [];
    const { execSync } = require('child_process');

    for (const filePath of files) {
      try {
        // Try staged diff first, then unstaged
        let diff = '';
        try {
          diff = execSync(`git diff --no-color -- "${filePath}"`, {
            cwd: wsFolder.uri.fsPath,
            encoding: 'utf-8',
            maxBuffer: 1024 * 256,
          }).trim();
        } catch { /* ignore */ }

        if (!diff) {
          try {
            diff = execSync(`git diff --cached --no-color -- "${filePath}"`, {
              cwd: wsFolder.uri.fsPath,
              encoding: 'utf-8',
              maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
        }

        // For new untracked files, show entire content as added
        if (!diff) {
          try {
            const status = execSync(`git status --porcelain -- "${filePath}"`, {
              cwd: wsFolder.uri.fsPath,
              encoding: 'utf-8',
            }).trim();
            if (status.startsWith('??') || status.startsWith('A ')) {
              const content = execSync(`cat "${filePath}"`, {
                cwd: wsFolder.uri.fsPath,
                encoding: 'utf-8',
                maxBuffer: 1024 * 256,
              });
              const lines = content.split('\n');
              diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
                lines.map((l: string) => '+' + l).join('\n');
            }
          } catch { /* ignore */ }
        }

        if (diff) {
          // Truncate very large diffs
          if (diff.length > 10000) {
            diff = diff.substring(0, 10000) + '\n... (truncated, diff too large)';
          }
          results.push({ path: filePath, diff });
        }
      } catch (err: any) {
        this.outputChannel.warn(`[Diff] Failed to compute diff for ${filePath}: ${err.message}`);
      }
    }

    return results;
  }

  /**
   * Get all uncommitted working tree changes with per-file unified diffs.
   * Unlike computeFileDiffs() which only covers agent-modified files,
   * this scans the entire working tree via git status.
   */
  private async getWorkingTreeDiffs(): Promise<{
    files: Array<{ path: string; status: string; diff: string }>;
    summary: { modified: number; added: number; deleted: number; totalAdded: number; totalRemoved: number };
  }> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return { files: [], summary: { modified: 0, added: 0, deleted: 0, totalAdded: 0, totalRemoved: 0 } };

    const { execSync } = require('child_process');
    let statusOutput = '';
    try {
      statusOutput = execSync('git status --porcelain', {
        cwd: wsFolder.uri.fsPath,
        encoding: 'utf-8',
        maxBuffer: 1024 * 256,
      }).trim();
    } catch {
      return { files: [], summary: { modified: 0, added: 0, deleted: 0, totalAdded: 0, totalRemoved: 0 } };
    }

    if (!statusOutput) {
      return { files: [], summary: { modified: 0, added: 0, deleted: 0, totalAdded: 0, totalRemoved: 0 } };
    }

    const statusLines = statusOutput.split('\n').filter(Boolean);
    const files: Array<{ path: string; status: string; diff: string }> = [];
    let totalAdded = 0, totalRemoved = 0;
    let modifiedCount = 0, addedCount = 0, deletedCount = 0;

    for (const line of statusLines) {
      const statusCode = line.substring(0, 2).trim();
      const filePath = line.substring(3).trim();

      // Classify status
      let status = 'modified';
      if (statusCode === '??' || statusCode === 'A') { status = 'added'; addedCount++; }
      else if (statusCode === 'D') { status = 'deleted'; deletedCount++; }
      else { modifiedCount++; }

      // Get diff for this file
      let diff = '';
      try {
        if (status === 'added') {
          // Untracked or newly added — show full content as added
          try {
            const content = execSync(`cat "${filePath}"`, {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            });
            const lines = content.split('\n');
            diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
              lines.map((l: string) => '+' + l).join('\n');
          } catch { /* ignore */ }
        } else if (status === 'deleted') {
          try {
            diff = execSync(`git diff --no-color -- "${filePath}"`, {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
          if (!diff) {
            try {
              diff = execSync(`git diff --cached --no-color -- "${filePath}"`, {
                cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
              }).trim();
            } catch { /* ignore */ }
          }
        } else {
          // Modified — try unstaged then staged
          try {
            diff = execSync(`git diff --no-color -- "${filePath}"`, {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
          if (!diff) {
            try {
              diff = execSync(`git diff --cached --no-color -- "${filePath}"`, {
                cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
              }).trim();
            } catch { /* ignore */ }
          }
        }

        // Count +/- lines
        if (diff) {
          const dLines = diff.split('\n');
          totalAdded += dLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          totalRemoved += dLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        }

        // Truncate very large diffs
        if (diff && diff.length > 15000) {
          diff = diff.substring(0, 15000) + '\n... (truncated, diff too large)';
        }
      } catch { /* ignore */ }

      files.push({ path: filePath, status, diff });
    }

    return {
      files,
      summary: { modified: modifiedCount, added: addedCount, deleted: deletedCount, totalAdded, totalRemoved },
    };
  }

  /**
   * Mark the current agent response as complete for a session.
   */
  private markAgentResponseComplete(ws: WebSocket): void {
    const clientInfo = this.clients.get(ws);
    const sessionId = clientInfo?.sessionId;
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.lastAgentResponse) {
      session.lastAgentResponse.complete = true;
      this.outputChannel.info(`[Session] Agent response complete for ${sessionId} (${session.lastAgentResponse.content.length} chars)`);
    }
  }

  dispose(): void {
    this.stop();
    this.interceptor.dispose();
    this.agent.dispose();
    this.tunnel.dispose();
    this.statusBarItem.dispose();
    this.sessions.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
