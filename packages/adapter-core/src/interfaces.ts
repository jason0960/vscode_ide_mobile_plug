import type {
  FileInfo,
  DiagnosticInfo,
  GitStatusInfo,
  ContextAttachment,
} from '@mobile-copilot/protocol';

// ─── ILogger ──────────────────────────────────────────────────────
// IDE-agnostic logging interface.

export interface ILogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

// ─── ISecretStore ─────────────────────────────────────────────────
// Persistent secret storage (tokens, pairing keys).

export interface ISecretStore {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// ─── IConfigProvider ──────────────────────────────────────────────
// Read-only access to configuration values.

export interface IConfigProvider {
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string): T | undefined;
}

// ─── IAgentOperations ─────────────────────────────────────────────
// Remote IDE control — file ops, terminal, editor, diagnostics, git.

export interface IAgentOperations {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  createFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
  editFile(
    filePath: string,
    edits: Array<{ range: { startLine: number; endLine: number }; newText: string }>
  ): Promise<void>;
  searchFiles(pattern: string): Promise<string[]>;
  runCommand(command: string): Promise<{ output: string; exitCode: number | null }>;
  openFile(filePath: string, options?: { line?: number; preview?: boolean }): Promise<void>;
  getActiveEditor(): Promise<{
    path: string;
    language: string;
    content: string;
    line: number;
    selection?: string;
  } | null>;
  getDiagnostics(filePath?: string): DiagnosticInfo[];
  getGitStatus(): Promise<{ branch: string; changes: Array<{ path: string; status: string }>; ahead: number; behind: number }>;
  gitDiff(filePath?: string): Promise<string>;
  getWorkspaceInfo(): Promise<{ name: string; path: string; folders: string[] }>;
  getFileTree(depth?: number): Promise<FileInfo[]>;
  listDirectory(dirPath?: string): Promise<Array<{ name: string; isDirectory: boolean; size?: number; modified?: string }>>;
  resolveWorkspacePath(relativePath: string): string;
  dispose(): void;
}

// ─── IContextProvider ─────────────────────────────────────────────
// Workspace context aggregation for prompts and mobile UI.

export interface IContextProvider {
  getWorkspaceInfo(): Promise<{
    name: string;
    path: string;
    folders: string[];
    gitBranch?: string;
  }>;
  listDirectory(dirPath?: string): Promise<Array<{
    name: string;
    isDirectory: boolean;
    size?: number;
    modified?: string;
  }>>;
  getFileTree(maxDepth?: number): Promise<FileInfo[]>;
  readFile(filePath: string, maxLines?: number): Promise<string>;
  getDiagnostics(): DiagnosticInfo[];
  getDiagnosticsSummary(): string;
  getOpenEditorPaths(): string[];
  getActiveEditorContext(): Promise<{
    path: string;
    language: string;
    content: string;
    line: number;
    selection?: string;
  } | null>;
  getGitStatus(): Promise<GitStatusInfo>;
  getGitBranch(): Promise<string>;
  getTerminals(): Array<{ name: string; active: boolean }>;
  buildPromptContext(): Promise<ContextAttachment[]>;
}

// ─── ICopilotBridge ───────────────────────────────────────────────
// LLM access — selecting models, sending prompts, streaming responses.

export interface ICopilotBridge {
  selectModel(modelFamily?: string): Promise<boolean>;
  sendPrompt(
    messages: Array<{ role: string; content: string }>,
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<string>;
  listModels(): Promise<Array<{
    id: string;
    family: string;
    version: string;
    maxInputTokens: number;
  }>>;
  countTokens(text: string): Promise<number>;
}

// ─── ITunnelProvider ──────────────────────────────────────────────
// Tunnel lifecycle for remote access.

export interface ITunnelProvider {
  startTunnel(port: number): Promise<string>;
  stopTunnel(): Promise<void>;
  getTunnelUrl(): string | null;
  isActive(): boolean;
  setManualUrl(url: string): void;
  dispose(): void;
}

// ─── Base Session State (used by BaseServer) ──────────────────────

export interface SessionState {
  ws: import('ws') | null;
  eventQueue: Array<{ method: string; data: any }>;
  lastAgentResponse: {
    content: string;
    complete: boolean;
    timestamp: number;
  } | null;
}

// ─── Client Info (used by BaseServer) ─────────────────────────────

export interface ClientInfo {
  authenticated: boolean;
  sessionId?: string;
}
