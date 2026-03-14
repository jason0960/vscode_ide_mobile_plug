import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import WebSocket = require('ws');
import { BaseServer } from '@mobile-copilot/adapter-core';
import type { ILogger } from '@mobile-copilot/adapter-core';
import type { ServerState, ChatMessage } from '@mobile-copilot/protocol';
import { VsCodeAuth } from './auth';
import { VsCodeTunnel } from './tunnel';
import { VsCodeConfig } from './config';
import { CopilotBridge } from './copilot';
import { ContextProvider } from './context';
import { AgentOperations } from './agent';
import { ChatResponseInterceptor } from './interceptor';
import { RelayClient } from './relay-client';
import {
  setMobileCallbacks,
  setCurrentMobileRequestId,
} from './participant';
import { findSafeBreak } from './stream-utils';

/**
 * VS Code implementation of the Mobile Copilot server.
 * Extends the portable BaseServer with IDE-specific RPC handlers,
 * capture strategies, workspace event listeners, and status bar.
 */
export class VsCodeServer extends BaseServer {
  private copilot: CopilotBridge;
  private contextProvider: ContextProvider;
  private agent: AgentOperations;
  private interceptor: ChatResponseInterceptor;
  private relay: RelayClient;
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private extensionContext: vscode.ExtensionContext;
  private config: VsCodeConfig;
  private relayClientCount = 0;

  // Activity tracking
  private activityTracking = false;
  private activityLog: Array<{ type: string; detail: string; timestamp: number }> = [];
  private agentModifiedFiles: Set<string> = new Set();

  declare protected readonly logger: ILogger & { channel: vscode.LogOutputChannel };

  constructor(
    context: vscode.ExtensionContext,
    logger: ILogger & { channel: vscode.LogOutputChannel },
    auth: VsCodeAuth,
    tunnel: VsCodeTunnel,
    config: VsCodeConfig,
  ) {
    super(logger, auth, tunnel);
    this.extensionContext = context;
    this.config = config;

    this.copilot = new CopilotBridge(logger.channel);
    this.contextProvider = new ContextProvider();
    this.agent = new AgentOperations(this.contextProvider, logger.channel);
    this.interceptor = new ChatResponseInterceptor(logger.channel);
    this.relay = new RelayClient(logger, config);

    // Relay event wiring
    this.setupRelayListeners();

    // Status bar
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'mobile-copilot.showQR';
    this.updateStatusBar('stopped');
  }

  // ─── BaseServer hooks ───────────────────────────────────────────

  protected getPort(): number {
    return this.config.get<number>('port', 3847) ?? 3847;
  }

  protected getStaticFilesPath(): string {
    const mobilePath = path.join(__dirname, 'mobile');
    return fs.existsSync(mobilePath) ? mobilePath : '';
  }

  protected setupAdditionalRoutes(): void {
    const mobilePath = path.join(__dirname, 'mobile');
    if (fs.existsSync(mobilePath)) {
      // Extra no-cache middleware for HTML/JS/CSS
      this.app.use((req, res, next) => {
        if (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.setHeader('Pragma', 'no-cache');
          res.setHeader('Expires', '0');
        }
        next();
      });

      // SPA fallback
      this.app.get('*', (req, res) => {
        if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.sendFile(path.join(mobilePath, 'index.html'));
        }
      });
    }
  }

  protected async onServerStarted(): Promise<void> {
    // Generate auth token for QR pairing
    await this.auth.generateToken();

    // Try tunnel
    const provider = this.config.get<string>('tunnelProvider', 'none');
    if (provider !== 'none') {
      try {
        const tunnelUrl = await (this.tunnel as any).startTunnel(this.port);
        this.logger.info(`Tunnel active: ${tunnelUrl}`);
        this.updateStatusBar('tunnel');
      } catch (err: any) {
        this.logger.warn(`Tunnel failed: ${err.message}`);
      }
    }

    this.updateStatusBar('running');
    this.statusBarItem.show();
    this.setupWorkspaceListeners();

    // Show QR
    await this.showQRCode();

    vscode.window.showInformationMessage(
      `Mobile Copilot server running on port ${this.port}. Scan the QR code to connect.`
    );
  }

  protected onServerStopping(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  protected onServerStopped(): void {
    this.updateStatusBar('stopped');
    vscode.window.showInformationMessage('Mobile Copilot server stopped.');
  }

  protected onClientConnected(_ws: WebSocket, _sessionId: string): void {
    this.updateStatusBar('connected');
  }

  protected onClientDisconnected(_ws: WebSocket, _sessionId: string): void {
    this.updateStatusBar(this.clients.size > 0 ? 'connected' : 'running');
  }

  // ─── Public API ─────────────────────────────────────────────────

  async showQRCode(): Promise<void> {
    const baseUrl = this.getServerUrl();
    await (this.auth as VsCodeAuth).showQRPanel(baseUrl);
  }

  async setTunnelUrl(url: string): Promise<void> {
    this.tunnel.setManualUrl(url.replace(/\/$/, ''));
    this.updateStatusBar('tunnel');
    await this.showQRCode();
    vscode.window.showInformationMessage(`QR code updated with tunnel URL: ${url}`);
  }

  async toggleTunnel(): Promise<void> {
    const tunnel = this.tunnel as VsCodeTunnel;
    await tunnel.toggleTunnel(this.port);
    this.updateStatusBar(tunnel.isActive() ? 'tunnel' : 'running');
    if (tunnel.isActive()) {
      await this.showQRCode();
    }
  }

  // ─── Cloud Relay ────────────────────────────────────────────────

  /** Connect to cloud relay and create a room. Returns the room code. */
  async connectRelay(): Promise<string> {
    const code = await this.relay.connect();
    this.updateStatusBar('relay');
    vscode.window.showInformationMessage(
      `Connected to relay! Room code: ${code}`,
      'Copy Code',
    ).then(choice => {
      if (choice === 'Copy Code') {
        vscode.env.clipboard.writeText(code);
      }
    });
    return code;
  }

  /** Disconnect from the cloud relay. */
  disconnectRelay(): void {
    this.relay.disconnect();
    this.relayClientCount = 0;
    this.updateStatusBar(this.server ? 'running' : 'stopped');
    vscode.window.showInformationMessage('Disconnected from relay.');
  }

  /** Get the current relay room code, or null. */
  getRelayCode(): string | null {
    return this.relay.code;
  }

  /**
   * Wire up relay events:
   * - Messages from mobile clients via relay → process through RPC
   * - Client join/leave → update status bar
   * - Disconnect → update status bar
   */
  private setupRelayListeners(): void {
    this.logger.info('[Relay] Setting up relay listeners');
    // A mobile client's message arrives via relay — run it through our RPC handler
    this.disposables.push(this.relay.onMessage.event(async (raw: string) => {
      try {
        this.logger.info(`[Relay] ━━━ Received message from mobile (${raw.length} bytes): ${raw.substring(0, 300)}`);

        // Handle auth directly — bypass virtual WS / RPC for this one message
        try {
          const msg = JSON.parse(raw);
          if (msg.method === 'auth') {
            // Relay auth: the room code IS the shared secret — if the mobile client
            // is in this room, it already proved it knows the code. Token-based auth
            // is for direct WS connections. For relay, accept auth if a token is
            // provided and valid, OR if the request indicates relay mode.
            const token = msg.params?.token;
            if (token) {
              const valid = await this.auth.validateToken(token);
              if (!valid) {
                this.logger.warn(`[Relay] Auth request rejected — invalid token`);
                const failResponse = JSON.stringify({
                  id: msg.id || crypto.randomUUID(),
                  type: 'event',
                  method: 'auth.failed',
                  params: { error: 'Invalid token' },
                });
                this.relay.send(failResponse);
                return;
              }
              this.logger.info(`[Relay] Auth validated via token`);
            } else {
              // No token — relay-mode auth (room code is the auth barrier)
              this.logger.info(`[Relay] Auth accepted via relay room membership`);
            }

            const session = this.auth.createSession();
            const authResponse = JSON.stringify({
              id: msg.id || crypto.randomUUID(),
              type: 'event',
              method: 'auth.success',
              params: { sessionId: session.id },
            });
            this.relay.send(authResponse);
            this.logger.info(`[Relay] auth.success sent: ${authResponse}`);

            // Set up the virtual WS and session for future messages
            const virtualWs = this.createRelayVirtualWs();
            this.clients.set(virtualWs, { authenticated: true, sessionId: session.id });
            this.registerSession(session.id, virtualWs);
            return;
          }
        } catch {
          // Not JSON — fall through
        }

        // Non-auth messages — require existing authenticated relay session
        const existingVws = this.getRelayVirtualWs();
        const clientInfo = existingVws ? this.clients.get(existingVws) : undefined;
        if (!existingVws || !clientInfo?.authenticated) {
          this.logger.warn(`[Relay] Dropping non-auth message — no authenticated relay session`);
          return;
        }

        this.logger.info(`[Relay] Routing non-auth message to RPC handler`);
        this.rpc.handleMessage(existingVws, raw);
        this.logger.info(`[Relay] rpc.handleMessage returned`);
      } catch (outerErr: any) {
        this.logger.error(`[Relay] FATAL handler error: ${outerErr.message}\n${outerErr.stack}`);
      }
    }));

    this.relay.onClientJoined.event(({ clientCount }) => {
      this.relayClientCount = clientCount;
      this.updateStatusBar('relay');
    });

    this.relay.onClientLeft.event(({ clientCount }) => {
      this.relayClientCount = clientCount;
      this.updateStatusBar('relay');
    });

    this.relay.onDisconnected.event(() => {
      this.relayClientCount = 0;
      // Don't update status bar here — reconnection will fire onRoomCreated
    });
  }

  /**
   * Create a virtual WebSocket that sends through the relay instead of a real socket.
   * This allows the existing RPC handler to work transparently.
   */
  private createRelayVirtualWs(): WebSocket {
    // We reuse the same virtual WS for all relay messages so session state persists
    const existing = this.getRelayVirtualWs();
    if (existing) return existing;

    const virtualWs = Object.create(null) as WebSocket;
    // Mark as relay virtual WS for identification
    (virtualWs as any).__isRelayVirtual = true;
    // Override send to route through relay
    virtualWs.send = ((data: string | Buffer) => {
      this.relay.send(typeof data === 'string' ? data : data.toString());
    }) as any;
    // Dynamic readyState based on relay connection
    Object.defineProperty(virtualWs, 'readyState', {
      get: () => this.relay.isConnected ? WebSocket.OPEN : WebSocket.CLOSED,
      configurable: true,
    });
    return virtualWs;
  }

  private getRelayVirtualWs(): WebSocket | null {
    for (const [ws] of this.clients) {
      if ((ws as any).__isRelayVirtual) return ws;
    }
    return null;
  }

  getState(): ServerState {
    return {
      running: this.server !== null,
      port: this.port,
      localUrl: `http://localhost:${this.port}`,
      externalUrl: this.getServerUrl(),
      tunnelUrl: this.tunnel.getTunnelUrl() || undefined,
      connectedClients: this.clients.size,
    };
  }

  // ─── RPC Handlers ───────────────────────────────────────────────

  protected setupRpcHandlers(): void {
    // ── Chat / Copilot — Agent Mode ──

    this.rpc.onStream('chat.sendToAgent', async (params, rawSend, ws) => {
      const { prompt } = params as { prompt: string };
      this.logger.info(`[Agent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      this.logger.info(`[Agent] Received prompt from mobile: "${prompt?.substring(0, 120)}"`);
      this.logger.info(`[Agent] WS type: ${typeof ws}, has send: ${typeof (ws as any)?.send}`);

      if (!prompt || !prompt.trim()) {
        this.logger.error('[Agent] Empty prompt received!');
        throw new Error('Prompt is required');
      }

      const send = this.createSessionAwareSend(ws, rawSend);
      this.agentModifiedFiles.clear();
      this.sendToAllSessions('agent.status', { status: 'running', timestamp: Date.now() });
      this.startActivityTracking();

      const allFolders = vscode.workspace.workspaceFolders;
      this.logger.info(`[Agent] Workspace folders: ${allFolders ? allFolders.map(f => f.uri.fsPath).join(', ') : 'NONE'}`);
      const wsFolder = allFolders?.[0];
      if (!wsFolder) {
        this.logger.error('[Agent] No workspace folder open!');
        this.sendToAllSessions('agent.status', { status: 'failed', error: 'No workspace folder open', timestamp: Date.now() });
        throw new Error('No workspace folder open');
      }
      this.logger.info(`[Agent] Using workspace folder: ${wsFolder.uri.fsPath}`);

      try {
        const captureMode = this.config.get<string>('captureMode', 'relay');
        this.logger.info(`[Agent] Capture mode: ${captureMode}`);

        const interceptorSession = this.interceptor.startSession((chunk) => {
          if (captureMode === 'interceptor' || captureMode === 'hybrid') {
            send(chunk);
          }
        });

        if (captureMode === 'relay' || captureMode === 'hybrid') {
          await this.runRelayCapture(prompt, wsFolder, send, captureMode === 'hybrid' ? interceptorSession : null);
        } else {
          await this.runInterceptorCapture(prompt, send, interceptorSession);
        }

        this.markAgentResponseComplete(ws);

        const fileDiffs = await this.computeFileDiffs();
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

    // ── Streaming LLM Chat (no tools) ──

    this.rpc.onStream('chat.send', async (params, send, _ws) => {
      this.logger.info(`[Chat] Received chat.send from mobile`);
      const { prompt, history, context, model } = params as {
        prompt: string;
        history?: ChatMessage[];
        context?: any[];
        model?: string;
      };

      if (model) {
        await this.copilot.selectModel(model);
      }

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

    // ── Workspace ──

    this.rpc.onRequest('workspace.info', async () => {
      return this.agent.getWorkspaceInfo();
    });

    this.rpc.onRequest('workspace.fileTree', async (params) => {
      return this.agent.getFileTree(params?.maxDepth);
    });

    this.rpc.onRequest('workspace.listDir', async (params) => {
      return this.agent.listDirectory(params.path);
    });

    // ── Files ──

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

    this.rpc.onRequest('git.changedFiles', async () => {
      return this.getWorkingTreeDiffs();
    });

    this.rpc.onRequest('git.restoreFiles', async (params) => {
      const files = params?.files as string[];
      return this.agent.gitRestoreFiles(files || []);
    });

    // Selectively revert specific diff hunks from a file
    this.rpc.onRequest('git.revertHunks', async (params) => {
      const filePath = params?.filePath as string;
      const hunkIndices = params?.hunkIndices as number[];
      const fullDiff = params?.diff as string;
      return this.agent.gitRevertHunks(filePath, hunkIndices, fullDiff);
    });

    this.rpc.onRequest('git.restoreChanges', async (params) => {
      const files = params?.files as string[] | undefined;
      const filesToRestore = files && files.length > 0
        ? files
        : Array.from(this.agentModifiedFiles);

      const result = await this.agent.gitRestoreChanges(filesToRestore);
      this.agentModifiedFiles.clear();
      this.logger.info(`[Git] Restored ${result.restored} files`);
      return result;
    });

    this.rpc.onRequest('agent.modifiedFiles', async () => {
      return { files: Array.from(this.agentModifiedFiles) };
    });

    // ── Server ──

    this.rpc.onRequest('server.state', async () => {
      return this.getState();
    });

    this.rpc.onRequest('ping', async () => {
      return { pong: true, timestamp: Date.now() };
    });
  }

  // ─── Capture Strategies ─────────────────────────────────────────

  /**
   * Find the last "safe" break point — delegates to the exported `findSafeBreak`.
   */
  private findSafeBreak(text: string): number {
    return findSafeBreak(text);
  }

  private async runRelayCapture(
    prompt: string,
    wsFolder: vscode.WorkspaceFolder,
    send: (chunk: string) => void,
    hybridInterceptorSession: { wait: () => Promise<any> } | null,
  ): Promise<void> {
    this.logger.info(`[Relay] ━━━ runRelayCapture START ━━━`);
    this.logger.info(`[Relay] Workspace folder: ${wsFolder.uri.fsPath}`);
    this.logger.info(`[Relay] Prompt length: ${prompt.length}`);
    const RELAY_FILENAME = '.copilot-mobile-relay.md';
    const relayUri = vscode.Uri.joinPath(wsFolder.uri, RELAY_FILENAME);
    this.logger.info(`[Relay] Relay file URI: ${relayUri.toString()}`);
    this.logger.info(`[Relay] Relay file fsPath: ${relayUri.fsPath}`);
    const DONE_MARKER = '<!-- MOBILE_DONE -->';
    const TIMEOUT_MS = 600_000; // 10 minutes — agent tasks with tool calls can be very long
    const POLL_INTERVAL_MS = 5_000;

    try {
      await vscode.workspace.fs.delete(relayUri);
      this.logger.info('[Relay] Deleted existing relay file');
    } catch {
      this.logger.info('[Relay] No existing relay file to delete (OK)');
    }

    // The relay file instruction is handled by .github/copilot-instructions.md
    // (injected as system context by VS Code). No prompt augmentation needed.

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

      // ── Core: read file, find safe break, stream only complete thoughts ──
      const checkFile = async () => {
        if (resolved) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(relayUri);
          const content = Buffer.from(bytes).toString('utf8').trimEnd();

          if (content.length === 0) return;
          this.logger.info(`[Relay] Poll: file ${content.length} chars, sent ${sentLength}`);

          // Check for DONE marker → flush everything
          if (content.includes(DONE_MARKER)) {
            const finalText = content.replace(DONE_MARKER, '').trimEnd();
            if (finalText.length > sentLength) {
              send(finalText.substring(sentLength));
            }
            lastContent = finalText;
            resolved = true;
            clearTimeout(timeoutTimer);
            clearInterval(pollTimer);
            watcher.dispose();
            resolve(lastContent);
            return;
          }

          // New content available?
          if (content.length <= sentLength) {
            return;
          }

          hasReceivedContent = true;

          // Only send up to the last safe break (complete sentence/paragraph)
          const newContent = content.substring(sentLength);
          const safeIdx = this.findSafeBreak(newContent);

          if (safeIdx > 0) {
            const safeChunk = newContent.substring(0, safeIdx);
            send(safeChunk);
            sentLength += safeIdx;
            lastContent = content.substring(0, sentLength);
            this.logger.info(`[Relay] Streamed ${safeChunk.length} chars (safe break). Total sent: ${sentLength}`);
          } else {
            this.logger.info(`[Relay] No safe break in ${newContent.length} new chars — holding`);
          }
        } catch (err: any) {
          this.logger.warn(`[Relay] Error reading file: ${err.message}`);
        }
      };

      // ── File watcher — react to file changes but throttle via the poll timer ──
      const pattern = new vscode.RelativePattern(wsFolder, RELAY_FILENAME);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      // Trigger an immediate check when the file first appears or changes
      let lastWatcherCheck = 0;
      const throttledCheck = () => {
        const now = Date.now();
        // Don't check more often than every 2 seconds from watcher events
        if (now - lastWatcherCheck < 2_000) return;
        lastWatcherCheck = now;
        checkFile();
      };
      watcher.onDidChange(throttledCheck);
      watcher.onDidCreate(throttledCheck);

      // ── Poll every POLL_INTERVAL_MS as the primary streaming mechanism ──
      const pollTimer = setInterval(checkFile, POLL_INTERVAL_MS);
    });

    send('⏳ *Waiting for Copilot agent response on desktop...*\n\n');

    const mobilePrompt = `[📱 Mobile] ${prompt}`;
    this.logger.info(`[Relay] ━━━ Executing workbench.action.chat.open ━━━`);
    this.logger.info(`[Relay] Prompt (first 200 chars): ${prompt.substring(0, 200)}`);
    
    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: mobilePrompt,
      isPartialQuery: false,
    }).then(
      () => this.logger.info('[Relay] ✓ Chat panel command executed SUCCESSFULLY'),
      (err: any) => this.logger.error(`[Relay] ✗ Failed to open Chat panel: ${err.message}`)
    );

    // Log available chat commands only when debug logging is enabled
    if (process.env.MCR_DEBUG === '1') {
      vscode.commands.getCommands(true).then(cmds => {
        const chatCmds = cmds.filter(c => c.includes('chat'));
        this.logger.info(`[Relay] Available chat commands: ${chatCmds.join(', ')}`);
      });
    }

    try {
      const fullText = await relayPromise;
      this.logger.info(`[Relay] Complete — ${fullText.length} chars sent to mobile.`);
      try { await vscode.workspace.fs.delete(relayUri); } catch { /* ignore */ }
    } catch (err: any) {
      this.logger.error(`[Relay] Error: ${err.message}`);

      if (hybridInterceptorSession) {
        this.logger.info('[Hybrid] Relay failed, checking interceptor results...');
        try {
          const interceptResult = await hybridInterceptorSession.wait();
          if (interceptResult.capturedText.length > 0) {
            this.logger.info(`[Hybrid] Interceptor captured ${interceptResult.capturedText.length} chars`);
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

    if (hybridInterceptorSession) {
      hybridInterceptorSession.wait().then((result: any) => {
        this.logger.info(
          `[Hybrid] Interceptor session completed. Schemes: [${Array.from(result.schemesSeen).join(', ')}]. ` +
          `URIs: ${result.documentUris.length}. File changes: ${result.fileChanges.length}.`
        );
      }).catch(() => { /* ignore */ });
    }
  }

  private async runInterceptorCapture(
    prompt: string,
    send: (chunk: string) => void,
    interceptorSession: { wait: () => Promise<any> },
  ): Promise<void> {
    send('⏳ *Sending to Copilot agent...*\n\n');

    const mobilePrompt = `[📱 Mobile] ${prompt}`;
    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: mobilePrompt,
      isPartialQuery: false,
    }).then(
      () => this.logger.info('[Interceptor] Chat panel command executed'),
      (err: any) => this.logger.error(`[Interceptor] Failed to open Chat panel: ${err.message}`)
    );

    try {
      const result = await interceptorSession.wait();

      if (result.capturedText.length === 0 && result.fileChanges.length > 0) {
        const summary = result.fileChanges
          .map((fc: any) => `• **${fc.path}** — ${fc.linesAdded} added, ${fc.linesRemoved} removed`)
          .join('\n');
        send(`\n\n📁 **Agent modified files:**\n${summary}`);
      } else if (result.capturedText.length === 0 && result.fileChanges.length === 0) {
        send('\n\n⚠️ Could not capture Copilot response. Check the Chat panel on your desktop.');
      }
    } catch (err: any) {
      this.logger.error(`[Interceptor] Error: ${err.message}`);
      send(`\n\n⚠️ ${err.message}`);
    }
  }

  // ─── Workspace Listeners ────────────────────────────────────────

  private setupWorkspaceListeners(): void {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => {
        const summary = this.contextProvider.getDiagnosticsSummary();
        this.broadcastToAuthenticated('diagnostics.changed', summary);

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

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) {
          this.logger.info(`[DocChange] ${e.document.uri.toString()} (scheme=${e.document.uri.scheme}, lang=${e.document.languageId})`);
        }

        this.interceptor.onDocumentChange(e);

        if (this.activityTracking && e.contentChanges.length > 0) {
          const uri = e.document.uri;
          if (uri.scheme !== 'file') return;

          const filePath = vscode.workspace.asRelativePath(uri);
          const totalCharsChanged = e.contentChanges.reduce(
            (sum, c) => sum + c.text.length + c.rangeLength, 0
          );
          if (totalCharsChanged > 5) {
            this.agentModifiedFiles.add(filePath);

            let linesAdded = 0;
            let linesRemoved = 0;
            const changeDetails: Array<{ range: string; preview: string }> = [];

            for (const change of e.contentChanges) {
              const newLines = change.text.split('\n').length - 1;
              const oldLines = change.range.end.line - change.range.start.line;
              linesAdded += newLines;
              linesRemoved += oldLines;

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
                changes: changeDetails.slice(0, 5),
              },
            };
            this.activityLog.push(activity);
            this.sendToAllSessions('agent.activity', activity);
          }
        }
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher.onDidCreate((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.created', { path: filePath });

        if (this.activityTracking) {
          this.agentModifiedFiles.add(filePath);
          const activity = { type: 'file-created', detail: `Created: ${filePath}`, timestamp: Date.now() };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher.onDidChange((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.changed', { path: filePath });

        if (this.activityTracking) {
          this.agentModifiedFiles.add(filePath);
          const activity = { type: 'file-changed', detail: `Modified: ${filePath}`, timestamp: Date.now() };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher.onDidDelete((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.deleted', { path: filePath });

        if (this.activityTracking) {
          const activity = { type: 'file-deleted', detail: `Deleted: ${filePath}`, timestamp: Date.now() };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      }),
      watcher
    );

    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        if (this.activityTracking) {
          const activity = { type: 'terminal', detail: `Terminal opened: ${terminal.name}`, timestamp: Date.now() };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );

    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.activityTracking) {
          const filePath = vscode.workspace.asRelativePath(doc.uri);
          const activity = { type: 'file-saved', detail: `Saved: ${filePath}`, timestamp: Date.now() };
          this.activityLog.push(activity);
          this.sendToAllSessions('agent.activity', activity);
        }
      })
    );
  }

  // ─── Activity Tracking ──────────────────────────────────────────

  private startActivityTracking(): void {
    this.activityTracking = true;
    this.activityLog = [];

    setTimeout(() => {
      this.activityTracking = false;
    }, 5 * 60 * 1000);
  }

  // ─── Diff Computation ──────────────────────────────────────────

  private async computeFileDiffs(): Promise<Array<{ path: string; diff: string }>> {
    const files = Array.from(this.agentModifiedFiles);
    if (files.length === 0) return [];

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return [];

    const results: Array<{ path: string; diff: string }> = [];
    const { execFileSync } = require('child_process');
    const fs = require('fs');

    for (const filePath of files) {
      try {
        let diff = '';
        try {
          diff = execFileSync('git', ['diff', '--no-color', '--', filePath], {
            cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
          }).trim();
        } catch { /* ignore */ }

        if (!diff) {
          try {
            diff = execFileSync('git', ['diff', '--cached', '--no-color', '--', filePath], {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
        }

        if (!diff) {
          try {
            const status = execFileSync('git', ['status', '--porcelain', '--', filePath], {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
            }).trim();
            if (status.startsWith('??') || status.startsWith('A ')) {
              const nodePath = require('path');
              const absPath = nodePath.resolve(wsFolder.uri.fsPath, filePath);
              const content = fs.readFileSync(absPath, 'utf-8');
              const lines = content.split('\n');
              diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n` +
                lines.map((l: string) => '+' + l).join('\n');
            }
          } catch { /* ignore */ }
        }

        if (diff) {
          if (diff.length > 10000) {
            diff = diff.substring(0, 10000) + '\n... (truncated, diff too large)';
          }
          results.push({ path: filePath, diff });
        }
      } catch (err: any) {
        this.logger.warn(`[Diff] Failed to compute diff for ${filePath}: ${err.message}`);
      }
    }

    return results;
  }

  private async getWorkingTreeDiffs(): Promise<{
    files: Array<{ path: string; status: string; diff: string }>;
    summary: { modified: number; added: number; deleted: number; totalAdded: number; totalRemoved: number };
  }> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) return { files: [], summary: { modified: 0, added: 0, deleted: 0, totalAdded: 0, totalRemoved: 0 } };

    const { execFileSync } = require('child_process');
    let statusOutput = '';
    try {
      statusOutput = execFileSync('git', ['status', '--porcelain'], {
        cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
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

      let status = 'modified';
      if (statusCode === '??' || statusCode === 'A') { status = 'added'; addedCount++; }
      else if (statusCode === 'D') { status = 'deleted'; deletedCount++; }
      else { modifiedCount++; }

      let diff = '';
      try {
        if (status === 'added') {
          try {
            const nodePath = require('path');
            const absPath = nodePath.resolve(wsFolder.uri.fsPath, filePath);
            const content = require('fs').readFileSync(absPath, 'utf-8');
            const contentLines = content.split('\n');
            diff = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${contentLines.length} @@\n` +
              contentLines.map((l: string) => '+' + l).join('\n');
          } catch { /* ignore */ }
        } else if (status === 'deleted') {
          try {
            diff = execFileSync('git', ['diff', '--no-color', '--', filePath], {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
          if (!diff) {
            try {
              diff = execFileSync('git', ['diff', '--cached', '--no-color', '--', filePath], {
                cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
              }).trim();
            } catch { /* ignore */ }
          }
        } else {
          try {
            diff = execFileSync('git', ['diff', '--no-color', '--', filePath], {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
            }).trim();
          } catch { /* ignore */ }
          if (!diff) {
            try {
              diff = execFileSync('git', ['diff', '--cached', '--no-color', '--', filePath], {
                cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
              }).trim();
            } catch { /* ignore */ }
          }
        }

        if (diff) {
          const dLines = diff.split('\n');
          totalAdded += dLines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length;
          totalRemoved += dLines.filter(l => l.startsWith('-') && !l.startsWith('---')).length;
        }

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

  // ─── Status Bar ─────────────────────────────────────────────────

  private updateStatusBar(state: 'stopped' | 'running' | 'connected' | 'tunnel' | 'relay'): void {
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
      case 'relay':
        const code = this.relay.code || '...';
        const count = this.relayClientCount;
        this.statusBarItem.text = `$(cloud) Mobile: Relay [${code}]`;
        this.statusBarItem.tooltip = `Cloud relay room: ${code}\n${count} device(s) connected`;
        this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
        break;
    }
    this.statusBarItem.show();
  }

  // ─── Dispose ────────────────────────────────────────────────────

  dispose(): void {
    this.stop();
    this.relay.dispose();
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
