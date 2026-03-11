// ─── RPC Protocol Types ───────────────────────────────────────────

export interface RpcMessage {
  id: string;
  type: 'request' | 'response' | 'stream' | 'event' | 'error';
  method?: string;
  params?: any;
  result?: any;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: any;
}

// ─── Chat Types ───────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface ChatRequest {
  prompt: string;
  history?: ChatMessage[];
  context?: ContextAttachment[];
  model?: string;
}

export interface ContextAttachment {
  type: 'file' | 'selection' | 'diagnostics' | 'terminal' | 'git';
  name: string;
  content: string;
}

// ─── Workspace Context Types ──────────────────────────────────────

export interface FileInfo {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  language?: string;
}

export interface DiagnosticInfo {
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
  code?: string | number;
}

export interface GitStatusInfo {
  branch: string;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface GitChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';
}

export interface TerminalInfo {
  id: number;
  name: string;
  isActive: boolean;
}

export interface WorkspaceInfo {
  name: string;
  rootPath: string;
  files: FileInfo[];
  openEditors: string[];
  diagnosticsSummary: { errors: number; warnings: number };
  gitBranch?: string;
}

// ─── Agent Operation Types ────────────────────────────────────────

export interface FileReadRequest {
  path: string;
  startLine?: number;
  endLine?: number;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  createIfMissing?: boolean;
}

export interface FileEditRequest {
  path: string;
  oldText: string;
  newText: string;
}

export interface TerminalRunRequest {
  command: string;
  terminalName?: string;
}

export interface SearchRequest {
  query: string;
  includePattern?: string;
  isRegex?: boolean;
  maxResults?: number;
}

// ─── Session Types ────────────────────────────────────────────────

export interface Session {
  id: string;
  token: string;
  connectedAt: number;
  lastActivity: number;
  userAgent?: string;
}

// ─── Server State ─────────────────────────────────────────────────

export interface ServerState {
  running: boolean;
  port: number;
  localUrl: string;
  externalUrl?: string;
  tunnelUrl?: string;
  connectedClients: number;
}

// ─── Event Types ──────────────────────────────────────────────────

export type ServerEvent =
  | { type: 'diagnosticsChanged'; data: DiagnosticInfo[] }
  | { type: 'fileChanged'; data: { path: string; changeType: 'created' | 'changed' | 'deleted' } }
  | { type: 'terminalOutput'; data: { terminalId: number; output: string } }
  | { type: 'activeEditorChanged'; data: { path: string | null } }
  | { type: 'serverStateChanged'; data: ServerState };
