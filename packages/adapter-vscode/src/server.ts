import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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
    return this.config.get<number>('port', 3847);
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
        const tunnelUrl = await this.tunnel.startTunnel(this.port);
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
    // A mobile client's message arrives via relay — run it through our RPC handler
    this.relay.onMessage.event((raw: string) => {
      // Create a virtual WebSocket-like object so the RPC handler can respond
      // Responses are sent back through the relay
      const virtualWs = this.createRelayVirtualWs();

      // Mark as authenticated (relay handles its own room auth)
      this.clients.set(virtualWs, { authenticated: true, sessionId: 'relay' });
      this.registerSession('relay', virtualWs);

      // Check if this is an auth message from the mobile client
      try {
        const msg = JSON.parse(raw);
        if (msg.method === 'auth') {
          // Auto-authenticate and send success
          this.rpc.sendEvent(virtualWs, 'auth.success', {
            sessionId: 'relay',
          });
          return;
        }
      } catch {
        // Not JSON — forward to RPC
      }

      this.rpc.handleMessage(virtualWs, raw);
    });

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

    const virtualWs = Object.create(WebSocket.prototype) as WebSocket;
    // Override send to route through relay
    (virtualWs as any).send = (data: string | Buffer) => {
      this.relay.send(typeof data === 'string' ? data : data.toString());
    };
    (virtualWs as any).readyState = WebSocket.OPEN;
    // Make readyState dynamic
    Object.defineProperty(virtualWs, 'readyState', {
      get: () => this.relay.isConnected ? WebSocket.OPEN : WebSocket.CLOSED,
    });
    return virtualWs;
  }

  private getRelayVirtualWs(): WebSocket | null {
    for (const [ws, info] of this.clients) {
      if (info.sessionId === 'relay') return ws;
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
      this.logger.info(`[Agent] Received prompt from mobile: "${prompt?.substring(0, 80)}"`);

      if (!prompt || !prompt.trim()) {
        throw new Error('Prompt is required');
      }

      const send = this.createSessionAwareSend(ws, rawSend);
      this.agentModifiedFiles.clear();
      this.sendToAllSessions('agent.status', { status: 'running', timestamp: Date.now() });
      this.startActivityTracking();

      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        this.sendToAllSessions('agent.status', { status: 'failed', error: 'No workspace folder open', timestamp: Date.now() });
        throw new Error('No workspace folder open');
      }

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
      if (!files || files.length === 0) {
        return { restored: 0, message: 'No files specified' };
      }
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) throw new Error('No workspace folder open');

      const { execSync } = require('child_process');
      const results: string[] = [];
      for (const filePath of files) {
        try {
          const status = execSync(`git status --porcelain -- "${filePath}"`, {
            cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
          }).trim();
          if (status.startsWith('??')) {
            execSync(`rm -f "${filePath}"`, { cwd: wsFolder.uri.fsPath });
          } else {
            execSync(`git restore "${filePath}"`, { cwd: wsFolder.uri.fsPath });
            try { execSync(`git restore --staged "${filePath}"`, { cwd: wsFolder.uri.fsPath }); } catch { /* ignore */ }
          }
          results.push(filePath);
        } catch (err: any) {
          this.logger.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
        }
      }
      return { restored: results.length, files: results };
    });

    this.rpc.onRequest('git.restoreChanges', async (params) => {
      const files = params?.files as string[] | undefined;
      const filesToRestore = files && files.length > 0
        ? files
        : Array.from(this.agentModifiedFiles);

      if (filesToRestore.length === 0) {
        return { restored: 0, message: 'No modified files to restore' };
      }

      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) throw new Error('No workspace folder open');

      const results: string[] = [];
      for (const filePath of filesToRestore) {
        try {
          const { execSync } = require('child_process');
          execSync(`git restore "${filePath}"`, { cwd: wsFolder.uri.fsPath });
          results.push(filePath);
        } catch (err: any) {
          this.logger.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
        }
      }

      this.agentModifiedFiles.clear();
      this.logger.info(`[Git] Restored ${results.length} files`);
      return { restored: results.length, files: results };
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
    const DEBOUNCE_MS = 4_000;

    try {
      await vscode.workspace.fs.delete(relayUri);
    } catch { /* ignore */ }

    const augmentedPrompt =
      prompt + '\n\n' +
      '--- IMPORTANT INSTRUCTION ---\n' +
      `After your response, also write your COMPLETE chat response (what you just said above) ` +
      `as markdown into the workspace file \`${RELAY_FILENAME}\`. ` +
      `This is to relay your answer to a mobile client that cannot see the chat panel. ` +
      `End the file content with exactly this marker on its own line: ${DONE_MARKER}\n` +
      'Copy your full response including explanations, code blocks, and formatting. ' +
      'Do NOT skip this step.';

    let lastContent = '';
    let sentLength = 0;
    let hasReceivedContent = false;

    const relayPromise = new Promise<string>((resolve, reject) => {
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let resolved = false;

      const timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
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

      const pattern = new vscode.RelativePattern(wsFolder, RELAY_FILENAME);
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      const checkFile = async () => {
        if (resolved) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(relayUri);
          const content = Buffer.from(bytes).toString('utf8').trim();

          if (content.length === 0) return;

          if (content.length > sentLength) {
            let newContent = content.substring(sentLength);
            const cleanContent = newContent.replace(DONE_MARKER, '').trimEnd();
            if (cleanContent.length > 0) {
              hasReceivedContent = true;
              send(cleanContent);
            }
            sentLength = content.length;
            lastContent = content.replace(DONE_MARKER, '').trimEnd();
          }

          if (content.includes(DONE_MARKER)) {
            resolved = true;
            clearTimeout(timeoutTimer);
            if (debounceTimer) clearTimeout(debounceTimer);
            watcher.dispose();
            resolve(lastContent);
            return;
          }

          if (hasReceivedContent) {
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
              if (!resolved) {
                try {
                  const finalBytes = await vscode.workspace.fs.readFile(relayUri);
                  const finalContent = Buffer.from(finalBytes).toString('utf8');
                  if (finalContent.length > sentLength) {
                    const remaining = finalContent.substring(sentLength).replace(DONE_MARKER, '').trimEnd();
                    if (remaining.length > 0) send(remaining);
                    lastContent = finalContent.replace(DONE_MARKER, '').trimEnd();
                  }
                } catch { /* ignore */ }

                resolved = true;
                clearTimeout(timeoutTimer);
                watcher.dispose();
                resolve(lastContent);
              }
            }, DEBOUNCE_MS);
          }
        } catch (err: any) {
          this.logger.warn(`[Relay] Error reading file: ${err.message}`);
        }
      };

      watcher.onDidChange(checkFile);
      watcher.onDidCreate(checkFile);
    });

    send('⏳ *Waiting for Copilot agent response on desktop...*\n\n');

    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: augmentedPrompt,
      isPartialQuery: false,
    }).then(
      () => this.logger.info('[Relay] Chat panel command executed'),
      (err: any) => this.logger.error(`[Relay] Failed to open Chat panel: ${err.message}`)
    );

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

    vscode.commands.executeCommand('workbench.action.chat.open', {
      query: prompt,
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
    const { execSync } = require('child_process');

    for (const filePath of files) {
      try {
        let diff = '';
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

        if (!diff) {
          try {
            const status = execSync(`git status --porcelain -- "${filePath}"`, {
              cwd: wsFolder.uri.fsPath, encoding: 'utf-8',
            }).trim();
            if (status.startsWith('??') || status.startsWith('A ')) {
              const content = execSync(`cat "${filePath}"`, {
                cwd: wsFolder.uri.fsPath, encoding: 'utf-8', maxBuffer: 1024 * 256,
              });
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

    const { execSync } = require('child_process');
    let statusOutput = '';
    try {
      statusOutput = execSync('git status --porcelain', {
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
