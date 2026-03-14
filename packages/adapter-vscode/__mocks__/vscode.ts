/**
 * Mock for the 'vscode' module — used by adapter-vscode tests.
 * Provides minimal stubs for all VS Code APIs used in the extension.
 */

const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file', path, toString: () => `file://${path}` }),
  parse: (s: string) => ({ fsPath: s, scheme: 'file', path: s, toString: () => s }),
  joinPath: (base: any, ...segments: string[]) => {
    const joined = [base.fsPath, ...segments].join('/');
    return { fsPath: joined, scheme: 'file', path: joined, toString: () => `file://${joined}` };
  },
};

const Range = jest.fn((startLine: number, startChar: number, endLine: number, endChar: number) => ({
  start: { line: startLine, character: startChar },
  end: { line: endLine, character: endChar },
}));

const Position = jest.fn((line: number, char: number) => ({ line, character: char }));

const WorkspaceEdit = jest.fn(() => ({
  replace: jest.fn(),
  insert: jest.fn(),
  delete: jest.fn(),
}));

const EventEmitter = jest.fn(() => ({
  event: jest.fn(),
  fire: jest.fn(),
  dispose: jest.fn(),
}));

const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/mock/workspace' }, name: 'mock', index: 0 }],
  fs: {
    readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    writeFile: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue({ type: 1, size: 100 }),
    readDirectory: jest.fn().mockResolvedValue([]),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  openTextDocument: jest.fn().mockResolvedValue({
    getText: () => '',
    lineCount: 0,
    languageId: 'plaintext',
    uri: { fsPath: '/mock/file.ts' },
  }),
  applyEdit: jest.fn().mockResolvedValue(true),
  findFiles: jest.fn().mockResolvedValue([]),
  asRelativePath: jest.fn((p: string) => p),
  getConfiguration: jest.fn(() => ({
    get: jest.fn((key: string, def?: any) => def),
  })),
  onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  onDidSaveTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
  createFileSystemWatcher: jest.fn(() => ({
    onDidCreate: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChange: jest.fn(() => ({ dispose: jest.fn() })),
    onDidDelete: jest.fn(() => ({ dispose: jest.fn() })),
    dispose: jest.fn(),
  })),
};

const window = {
  activeTextEditor: undefined as any,
  createTerminal: jest.fn(() => ({
    sendText: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
    name: 'mock-terminal',
  })),
  createStatusBarItem: jest.fn(() => ({
    text: '',
    tooltip: '',
    command: undefined,
    backgroundColor: undefined,
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  })),
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn(),
  showErrorMessage: jest.fn(),
  createWebviewPanel: jest.fn(() => ({
    webview: { html: '' },
    dispose: jest.fn(),
  })),
  terminals: [],
  onDidChangeActiveTextEditor: jest.fn(() => ({ dispose: jest.fn() })),
  onDidOpenTerminal: jest.fn(() => ({ dispose: jest.fn() })),
};

const commands = {
  executeCommand: jest.fn().mockResolvedValue(undefined),
  registerCommand: jest.fn(),
  getCommands: jest.fn().mockResolvedValue([]),
};

const extensions = {
  getExtension: jest.fn(),
};

const languages = {
  getDiagnostics: jest.fn().mockReturnValue([]),
  onDidChangeDiagnostics: jest.fn(() => ({ dispose: jest.fn() })),
};

const StatusBarAlignment = { Left: 1, Right: 2 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

// Language Model API stubs
const lm = {
  selectChatModels: jest.fn().mockResolvedValue([]),
};

const LanguageModelChatMessage = {
  User: jest.fn((content: string) => ({ role: 'user', content })),
  Assistant: jest.fn((content: string) => ({ role: 'assistant', content })),
};

class LanguageModelError extends Error {
  code: string;
  static NotFound = jest.fn((msg?: string) => new LanguageModelError(msg || 'NotFound', 'NotFound'));
  static NoPermissions = jest.fn((msg?: string) => new LanguageModelError(msg || 'NoPermissions', 'NoPermissions'));
  static Blocked = jest.fn((msg?: string) => new LanguageModelError(msg || 'Blocked', 'Blocked'));
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const CancellationTokenSource = jest.fn(() => ({
  token: { isCancellationRequested: false, onCancellationRequested: jest.fn() },
  cancel: jest.fn(),
  dispose: jest.fn(),
}));

class TabInputText {
  uri: any;
  constructor(uri: any) { this.uri = uri; }
}

class RelativePattern {
  base: any;
  pattern: string;
  constructor(base: any, pattern: string) { this.base = base; this.pattern = pattern; }
}

class ThemeColor {
  id: string;
  constructor(id: string) { this.id = id; }
}

const env = {
  clipboard: {
    writeText: jest.fn().mockResolvedValue(undefined),
    readText: jest.fn().mockResolvedValue(''),
  },
};

module.exports = {
  Uri,
  Range,
  Position,
  WorkspaceEdit,
  EventEmitter,
  workspace,
  window,
  commands,
  extensions,
  languages,
  lm,
  env,
  StatusBarAlignment,
  DiagnosticSeverity,
  FileType,
  LanguageModelChatMessage,
  LanguageModelError,
  CancellationTokenSource,
  TabInputText,
  RelativePattern,
  ThemeColor,
};
