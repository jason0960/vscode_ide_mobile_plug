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
  private port: number;
  private statusBarItem: vscode.StatusBarItem;
  private disposables: vscode.Disposable[] = [];
  private extensionContext: vscode.ExtensionContext;

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
      this.app.use(express.static(mobilePath));

      // SPA fallback — serve index.html for unmatched routes
      this.app.get('*', (req, res) => {
        if (!req.path.startsWith('/api') && !req.path.startsWith('/ws')) {
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
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: msg.params.sessionId });
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
                this.rpc.sendEvent(ws, 'auth.success', { sessionId: session.id });
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

    // AGENT MODE — file-relay approach.
    // 1. Inject prompt into native Copilot Chat (full agent with tools on desktop)
    // 2. Prompt includes instruction for Copilot to write its response to a relay file
    // 3. FileSystemWatcher detects the write and streams content to mobile
    // Result: Mobile gets the SAME response as desktop.
    this.rpc.onStream('chat.sendToAgent', async (params, send) => {
      const { prompt } = params as { prompt: string };
      this.outputChannel.info(`[Agent] Received prompt from mobile: "${prompt?.substring(0, 80)}"`);

      if (!prompt || !prompt.trim()) {
        throw new Error('Prompt is required');
      }

      // Start tracking agent activity
      this.startActivityTracking();

      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      if (!wsFolder) {
        throw new Error('No workspace folder open');
      }

      const RELAY_FILENAME = '.copilot-mobile-relay.md';
      const relayUri = vscode.Uri.joinPath(wsFolder.uri, RELAY_FILENAME);
      const DONE_MARKER = '<!-- MOBILE_DONE -->';
      const TIMEOUT_MS = 180_000; // 3 min for agent work
      const DEBOUNCE_MS = 4_000;  // 4s after last write = "done"

      // Delete relay file instead of clearing (avoids triggering watcher with empty file)
      try {
        await vscode.workspace.fs.delete(relayUri);
      } catch { /* ignore if it doesn't exist */ }

      // Build the augmented prompt — tells Copilot to write its chat response to the relay file
      const augmentedPrompt =
        prompt + '\n\n' +
        '--- IMPORTANT INSTRUCTION ---\n' +
        `After your response, also write your COMPLETE chat response (what you just said above) ` +
        `as markdown into the workspace file \`${RELAY_FILENAME}\`. ` +
        `This is to relay your answer to a mobile client that cannot see the chat panel. ` +
        `End the file content with exactly this marker on its own line: ${DONE_MARKER}\n` +
        'Copy your full response including explanations, code blocks, and formatting. ' +
        'Do NOT skip this step.';

      // Watch for relay file changes and stream content to mobile
      let lastContent = '';
      let sentLength = 0;
      let hasReceivedContent = false; // Only debounce AFTER we get real content

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

            // Skip empty file writes (e.g. file created but not yet written)
            if (content.length === 0) {
              this.outputChannel.info('[Agent] Relay file is empty, waiting for content...');
              return;
            }

            if (content.length > sentLength) {
              let newContent = content.substring(sentLength);
              const cleanContent = newContent.replace(DONE_MARKER, '').trimEnd();
              if (cleanContent.length > 0) {
                hasReceivedContent = true;
                send(cleanContent);
                this.outputChannel.info(`[Agent] Sent ${cleanContent.length} chars to mobile`);
              }
              sentLength = content.length;
              lastContent = content.replace(DONE_MARKER, '').trimEnd();
            }

            if (content.includes(DONE_MARKER)) {
              resolved = true;
              clearTimeout(timeoutTimer);
              if (debounceTimer) clearTimeout(debounceTimer);
              watcher.dispose();
              this.outputChannel.info('[Agent] DONE marker detected in relay file');
              resolve(lastContent);
              return;
            }

            // Only start debounce AFTER we have received real content
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
                  this.outputChannel.info('[Agent] Debounce timeout — assuming agent is done');
                  resolve(lastContent);
                }
              }, DEBOUNCE_MS);
            }
          } catch (err: any) {
            this.outputChannel.warn(`[Agent] Error reading relay file: ${err.message}`);
          }
        };

        watcher.onDidChange(checkFile);
        watcher.onDidCreate(checkFile);
      });

      // Inject prompt into native Copilot Chat panel
      this.outputChannel.info('[Agent] Injecting prompt into native Copilot Chat panel...');
      send('⏳ *Waiting for Copilot agent response on desktop...*\n\n');

      vscode.commands.executeCommand('workbench.action.chat.open', {
        query: augmentedPrompt,
        isPartialQuery: false,
      }).then(
        () => this.outputChannel.info('[Agent] Chat panel command executed'),
        (err: any) => this.outputChannel.error(`[Agent] Failed to open Chat panel: ${err.message}`)
      );

      // Wait for relay file
      try {
        const fullText = await relayPromise;
        this.outputChannel.info(`[Agent] Relay complete — ${fullText.length} chars sent to mobile.`);
        try { await vscode.workspace.fs.delete(relayUri); } catch { /* ignore */ }
      } catch (err: any) {
        this.outputChannel.error(`[Agent] Relay error: ${err.message}`);
        send(`\n\n⚠️ ${err.message}`);
      }
    });

    // STREAMING MODE — uses vscode.lm API for raw LLM chat (no tools/agent).
    this.rpc.onStream('chat.send', async (params, send) => {
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

    // ── Server State ──
    this.rpc.onRequest('server.state', async () => {
      return this.getState();
    });

    // ── Ping ──
    this.rpc.onRequest('ping', async () => {
      return { pong: true, timestamp: Date.now() };
    });
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
          this.broadcastToAuthenticated('agent.activity', activity);
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
          this.broadcastToAuthenticated('agent.activity', activity);
        }
      })
    );

    // Text document changes (agent editing files)
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.activityTracking && e.contentChanges.length > 0) {
          const filePath = vscode.workspace.asRelativePath(e.document.uri);
          // Debounce: don't send for every keystroke, only meaningful edits
          const totalCharsChanged = e.contentChanges.reduce(
            (sum, c) => sum + c.text.length + c.rangeLength, 0
          );
          if (totalCharsChanged > 5) {
            const activity = {
              type: 'edit',
              detail: `Editing: ${filePath} (${e.contentChanges.length} changes)`,
              timestamp: Date.now(),
            };
            this.activityLog.push(activity);
            this.broadcastToAuthenticated('agent.activity', activity);
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
          const activity = {
            type: 'file-created',
            detail: `Created: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.broadcastToAuthenticated('agent.activity', activity);
        }
      }),
      watcher.onDidChange((uri) => {
        const filePath = vscode.workspace.asRelativePath(uri);
        this.broadcastToAuthenticated('file.changed', { path: filePath });

        if (this.activityTracking) {
          const activity = {
            type: 'file-changed',
            detail: `Modified: ${filePath}`,
            timestamp: Date.now(),
          };
          this.activityLog.push(activity);
          this.broadcastToAuthenticated('agent.activity', activity);
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
          this.broadcastToAuthenticated('agent.activity', activity);
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
          this.broadcastToAuthenticated('agent.activity', activity);
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
          this.broadcastToAuthenticated('agent.activity', activity);
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

  dispose(): void {
    this.stop();
    this.agent.dispose();
    this.tunnel.dispose();
    this.statusBarItem.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
