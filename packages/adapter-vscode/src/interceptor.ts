import * as vscode from 'vscode';

/**
 * Result from an interception session.
 */
export interface InterceptorResult {
  /** All unique document URIs that changed during the session */
  documentUris: string[];
  /** File changes detected in the workspace (actual files, not chat docs) */
  fileChanges: Array<{
    path: string;
    linesAdded: number;
    linesRemoved: number;
    changeType: 'created' | 'modified' | 'deleted';
  }>;
  /** Any text captured from chat-related documents (if detected) */
  capturedText: string;
  /** Raw log of all URI schemes seen — useful for discovery */
  schemesSeen: Set<string>;
}

/**
 * An active interception session.
 */
interface ActiveSession {
  id: string;
  sendChunk: (chunk: string) => void;
  resolve: (result: InterceptorResult) => void;
  reject: (err: Error) => void;
  documentUris: Map<string, string>; // uri → last known content hash
  chatDocumentUri: string | null;    // detected chat session document URI
  chatSentLength: number;            // cursor for incremental streaming
  fileChanges: Map<string, { linesAdded: number; linesRemoved: number; changeType: 'created' | 'modified' | 'deleted' }>;
  schemesSeen: Set<string>;
  capturedText: string;
  activityDebounceTimer: ReturnType<typeof setTimeout> | null;
  timeoutTimer: ReturnType<typeof setTimeout>;
  hasSeenActivity: boolean;
  disposed: boolean;
}

/**
 * Chat Response Interceptor
 *
 * Monitors ALL document changes in VS Code to:
 * 1. Log every URI (scheme, path, language) for debugging/discovery
 * 2. Detect chat session documents by scheme (e.g., vscode-chat-*)
 * 3. Track file changes made by Copilot agent with diff info
 * 4. Stream captured content to mobile via callback
 *
 * This replaces the relay file approach. Instead of instructing Copilot
 * to write a file, we passively observe what VS Code does internally.
 */
export class ChatResponseInterceptor {
  private outputChannel: vscode.LogOutputChannel;
  private activeSession: ActiveSession | null = null;
  private fileCreateListener: vscode.Disposable | null = null;
  private fileSaveListener: vscode.Disposable | null = null;
  private fileDeleteListener: vscode.Disposable | null = null;

  // Known chat-related URI schemes to watch for.
  // This list will grow as we discover what VS Code uses internally.
  private static readonly CHAT_SCHEMES = new Set([
    'vscode-chat',
    'vscode-copilot-chat',
    'vscode-chat-response',
    'copilot-chat',
    'comment',                 // VS Code inline comments can relate to chat
    'vscode-interactive',      // Interactive window (notebook-like)
    'vscode-interactive-input', // Interactive input
  ]);

  // Schemes to ignore completely (no logging, no processing)
  private static readonly IGNORE_SCHEMES = new Set([
    'output',       // Output channel documents — we'd be logging ourselves
    'vscode-scm',   // SCM input box
  ]);

  // Minimum debounce before considering agent "done" (ms)
  private static readonly ACTIVITY_DEBOUNCE_MS = 6_000;
  // Maximum session duration (ms)
  private static readonly SESSION_TIMEOUT_MS = 180_000;

  constructor(outputChannel: vscode.LogOutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Start a new interception session.
   * Returns a session handle with a `wait()` promise.
   */
  startSession(sendChunk: (chunk: string) => void): { wait: () => Promise<InterceptorResult> } {
    // Dispose previous session if any
    if (this.activeSession && !this.activeSession.disposed) {
      this.endSession('Superseded by new session');
    }

    let resolvePromise!: (result: InterceptorResult) => void;
    let rejectPromise!: (err: Error) => void;

    const promise = new Promise<InterceptorResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const sessionId = `session_${Date.now()}`;

    const session: ActiveSession = {
      id: sessionId,
      sendChunk,
      resolve: resolvePromise,
      reject: rejectPromise,
      documentUris: new Map(),
      chatDocumentUri: null,
      chatSentLength: 0,
      fileChanges: new Map(),
      schemesSeen: new Set(),
      capturedText: '',
      activityDebounceTimer: null,
      timeoutTimer: setTimeout(() => {
        this.outputChannel.info(`[Interceptor] Session ${sessionId} timed out after ${ChatResponseInterceptor.SESSION_TIMEOUT_MS / 1000}s`);
        this.endSession('Timeout');
      }, ChatResponseInterceptor.SESSION_TIMEOUT_MS),
      hasSeenActivity: false,
      disposed: false,
    };

    this.activeSession = session;

    // Listen for file creates/saves/deletes during this session
    this.fileCreateListener = vscode.workspace.onDidCreateFiles((e) => {
      if (!this.activeSession || this.activeSession.disposed) return;
      for (const file of e.files) {
        const filePath = vscode.workspace.asRelativePath(file);
        this.activeSession.fileChanges.set(filePath, {
          linesAdded: 0,
          linesRemoved: 0,
          changeType: 'created',
        });
        this.outputChannel.info(`[Interceptor] File created: ${filePath}`);
        this.bumpDebounce();
      }
    });

    this.fileSaveListener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!this.activeSession || this.activeSession.disposed) return;
      if (doc.uri.scheme !== 'file') return;
      const filePath = vscode.workspace.asRelativePath(doc.uri);
      this.outputChannel.info(`[Interceptor] File saved: ${filePath}`);
      this.bumpDebounce();
    });

    this.fileDeleteListener = vscode.workspace.onDidDeleteFiles((e) => {
      if (!this.activeSession || this.activeSession.disposed) return;
      for (const file of e.files) {
        const filePath = vscode.workspace.asRelativePath(file);
        this.activeSession.fileChanges.set(filePath, {
          linesAdded: 0,
          linesRemoved: 0,
          changeType: 'deleted',
        });
        this.outputChannel.info(`[Interceptor] File deleted: ${filePath}`);
        this.bumpDebounce();
      }
    });

    this.outputChannel.info(`[Interceptor] Session ${sessionId} started — monitoring all document changes`);

    return { wait: () => promise };
  }

  /**
   * Called by the server's onDidChangeTextDocument listener.
   * This is the main entry point for document change events.
   */
  onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.activeSession || this.activeSession.disposed) return;
    if (e.contentChanges.length === 0) return;

    const uri = e.document.uri;
    const scheme = uri.scheme;
    const uriString = uri.toString();

    // Skip schemes we know are irrelevant
    if (ChatResponseInterceptor.IGNORE_SCHEMES.has(scheme)) return;

    // Track scheme for discovery
    this.activeSession.schemesSeen.add(scheme);

    // Log EVERY change for diagnostic purposes
    this.outputChannel.info(
      `[Interceptor] DocChange: scheme=${scheme} uri=${uriString} ` +
      `lang=${e.document.languageId} version=${e.document.version} ` +
      `changes=${e.contentChanges.length} ` +
      `totalNewChars=${e.contentChanges.reduce((s, c) => s + c.text.length, 0)}`
    );

    // Track this URI
    this.activeSession.documentUris.set(uriString, scheme);

    // Check if this looks like a chat document
    if (this.isChatDocument(uri, e.document)) {
      this.handleChatDocumentChange(e);
    }

    // Track workspace file changes with diff info
    if (scheme === 'file') {
      const filePath = vscode.workspace.asRelativePath(uri);
      // Skip the relay file if it somehow still exists
      if (filePath === '.copilot-mobile-relay.md') return;

      const existing = this.activeSession.fileChanges.get(filePath) || {
        linesAdded: 0,
        linesRemoved: 0,
        changeType: 'modified' as const,
      };

      for (const change of e.contentChanges) {
        const newLines = change.text.split('\n').length - 1;
        const oldLines = change.range.end.line - change.range.start.line;
        existing.linesAdded += Math.max(0, newLines);
        existing.linesRemoved += Math.max(0, oldLines);
      }

      this.activeSession.fileChanges.set(filePath, existing);
      this.activeSession.hasSeenActivity = true;
      this.bumpDebounce();
    }

    // Also bump debounce for non-file schemes that might be chat
    if (scheme !== 'file') {
      this.activeSession.hasSeenActivity = true;
      this.bumpDebounce();
    }
  }

  /**
   * Determine if a document might be a chat session document.
   */
  private isChatDocument(uri: vscode.Uri, doc: vscode.TextDocument): boolean {
    const scheme = uri.scheme;

    // Direct scheme match
    if (ChatResponseInterceptor.CHAT_SCHEMES.has(scheme)) {
      return true;
    }

    // Heuristic: non-file, non-standard scheme with markdown-like content
    if (scheme !== 'file' && scheme !== 'untitled' && scheme !== 'git') {
      const text = doc.getText();
      // If it contains markdown-like content and is being actively written to
      if (text.length > 50 && (text.includes('```') || text.includes('**') || text.includes('##'))) {
        this.outputChannel.info(
          `[Interceptor] Potential chat document detected: scheme=${scheme} uri=${uri.toString()} ` +
          `contentLength=${text.length}`
        );
        return true;
      }
    }

    return false;
  }

  /**
   * Handle changes to a detected chat document — stream incremental content.
   */
  private handleChatDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.activeSession || this.activeSession.disposed) return;

    const uriString = e.document.uri.toString();
    const fullText = e.document.getText();

    // If this is a new chat document, set it as our target
    if (!this.activeSession.chatDocumentUri) {
      this.activeSession.chatDocumentUri = uriString;
      this.outputChannel.info(`[Interceptor] Locked onto chat document: ${uriString}`);
    }

    // Only process our locked-on document
    if (uriString !== this.activeSession.chatDocumentUri) return;

    // Stream only new content (incremental)
    if (fullText.length > this.activeSession.chatSentLength) {
      const newContent = fullText.substring(this.activeSession.chatSentLength);
      this.activeSession.chatSentLength = fullText.length;
      this.activeSession.capturedText = fullText;

      // Stream the new chunk to mobile
      this.activeSession.sendChunk(newContent);
      this.outputChannel.info(`[Interceptor] Streamed ${newContent.length} chars from chat document`);
    }
  }

  /**
   * Bump the activity debounce timer.
   * When no activity occurs for ACTIVITY_DEBOUNCE_MS, we consider the agent done.
   */
  private bumpDebounce(): void {
    if (!this.activeSession || this.activeSession.disposed) return;

    if (this.activeSession.activityDebounceTimer) {
      clearTimeout(this.activeSession.activityDebounceTimer);
    }

    this.activeSession.activityDebounceTimer = setTimeout(() => {
      if (this.activeSession && !this.activeSession.disposed && this.activeSession.hasSeenActivity) {
        this.outputChannel.info(`[Interceptor] No activity for ${ChatResponseInterceptor.ACTIVITY_DEBOUNCE_MS / 1000}s — ending session`);
        this.endSession('Activity debounce');
      }
    }, ChatResponseInterceptor.ACTIVITY_DEBOUNCE_MS);
  }

  /**
   * End the current session and resolve the promise.
   */
  private endSession(reason: string): void {
    const session = this.activeSession;
    if (!session || session.disposed) return;

    session.disposed = true;

    // Clear timers
    clearTimeout(session.timeoutTimer);
    if (session.activityDebounceTimer) {
      clearTimeout(session.activityDebounceTimer);
    }

    // Dispose file listeners
    this.fileCreateListener?.dispose();
    this.fileSaveListener?.dispose();
    this.fileDeleteListener?.dispose();
    this.fileCreateListener = null;
    this.fileSaveListener = null;
    this.fileDeleteListener = null;

    // Build result
    const result: InterceptorResult = {
      documentUris: Array.from(session.documentUris.keys()),
      fileChanges: Array.from(session.fileChanges.entries()).map(([path, info]) => ({
        path,
        ...info,
      })),
      capturedText: session.capturedText,
      schemesSeen: session.schemesSeen,
    };

    this.outputChannel.info(
      `[Interceptor] Session ${session.id} ended (${reason}). ` +
      `Schemes seen: [${Array.from(session.schemesSeen).join(', ')}]. ` +
      `URIs tracked: ${session.documentUris.size}. ` +
      `File changes: ${session.fileChanges.size}. ` +
      `Chat text captured: ${session.capturedText.length} chars.`
    );

    session.resolve(result);
    this.activeSession = null;
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    if (this.activeSession && !this.activeSession.disposed) {
      this.endSession('Extension deactivating');
    }
    this.fileCreateListener?.dispose();
    this.fileSaveListener?.dispose();
    this.fileDeleteListener?.dispose();
  }
}
