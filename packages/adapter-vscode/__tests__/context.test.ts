/**
 * ContextProvider — unit tests
 *
 * Covers: getWorkspaceInfo, listDirectory, readFile (with line ranges),
 * getDiagnostics, getDiagnosticsSummary, getLanguageId (private, tested
 * indirectly via getFileTree).
 *
 * The vscode module is mocked via __mocks__/vscode.ts.
 */
jest.mock('vscode');
const vscode = require('vscode');

import { ContextProvider } from '../src/context';

describe('ContextProvider', () => {
  let ctx: ContextProvider;

  beforeEach(() => {
    ctx = new ContextProvider();

    // Reset mock defaults
    vscode.workspace.workspaceFolders = [
      { uri: { fsPath: '/workspace/project' }, name: 'my-project', index: 0 },
    ];
    vscode.workspace.fs.readFile.mockResolvedValue(Buffer.from(''));
    vscode.workspace.fs.readDirectory.mockResolvedValue([]);
    vscode.languages.getDiagnostics.mockReturnValue([]);
    vscode.workspace.asRelativePath.mockImplementation((p: any) =>
      typeof p === 'string' ? p : p.fsPath || p.path || String(p),
    );
    // Mock tabGroups for getOpenEditorPaths
    vscode.window.tabGroups = { all: [] };
    // Mock git extension as not found
    vscode.extensions.getExtension.mockReturnValue(null);
  });

  // ─── getWorkspaceInfo ─────────────────────────────────────────

  describe('getWorkspaceInfo', () => {
    it('returns "No Workspace" when no folders open', async () => {
      vscode.workspace.workspaceFolders = null;
      const info = await ctx.getWorkspaceInfo();
      expect(info.name).toBe('No Workspace');
      expect(info.files).toEqual([]);
    });

    it('returns workspace name and root path', async () => {
      vscode.workspace.fs.readDirectory.mockResolvedValue([
        ['src', vscode.FileType.Directory],
        ['package.json', vscode.FileType.File],
      ]);

      const info = await ctx.getWorkspaceInfo();
      expect(info.name).toBe('my-project');
      expect(info.rootPath).toBe('/workspace/project');
    });
  });

  // ─── listDirectory ────────────────────────────────────────────

  describe('listDirectory', () => {
    it('returns sorted entries (directories first)', async () => {
      vscode.workspace.fs.readDirectory.mockResolvedValue([
        ['file.ts', vscode.FileType.File],
        ['src', vscode.FileType.Directory],
        ['another.js', vscode.FileType.File],
      ]);

      const entries = await ctx.listDirectory('/workspace/project');
      expect(entries[0].name).toBe('src');
      expect(entries[0].isDirectory).toBe(true);
      expect(entries[1].name).toBe('another.js');
      expect(entries[2].name).toBe('file.ts');
    });

    it('returns empty array on error', async () => {
      vscode.workspace.fs.readDirectory.mockRejectedValue(new Error('Not found'));
      const entries = await ctx.listDirectory('/nonexistent');
      expect(entries).toEqual([]);
    });
  });

  // ─── readFile ─────────────────────────────────────────────────

  describe('readFile', () => {
    it('reads full file content', async () => {
      vscode.workspace.fs.readFile.mockResolvedValue(
        Buffer.from('line1\nline2\nline3'),
      );

      const content = await ctx.readFile('/workspace/project/file.ts');
      expect(content).toBe('line1\nline2\nline3');
    });

    it('reads specific line range', async () => {
      vscode.workspace.fs.readFile.mockResolvedValue(
        Buffer.from('line1\nline2\nline3\nline4\nline5'),
      );

      const content = await ctx.readFile('/workspace/project/file.ts', 2, 4);
      expect(content).toBe('line2\nline3\nline4');
    });

    it('handles startLine only', async () => {
      vscode.workspace.fs.readFile.mockResolvedValue(
        Buffer.from('a\nb\nc\nd'),
      );

      const content = await ctx.readFile('/workspace/project/file.ts', 3);
      expect(content).toBe('c\nd');
    });
  });

  // ─── getDiagnostics ───────────────────────────────────────────

  describe('getDiagnostics', () => {
    it('converts vscode diagnostics to DiagnosticInfo', () => {
      vscode.languages.getDiagnostics.mockReturnValue([
        [
          { fsPath: '/workspace/project/src/app.ts' },
          [
            {
              range: { start: { line: 9, character: 3 } },
              severity: vscode.DiagnosticSeverity.Error,
              message: 'Type error',
              source: 'ts',
              code: 2345,
            },
          ],
        ],
      ]);

      const diags = ctx.getDiagnostics();
      expect(diags).toHaveLength(1);
      expect(diags[0].line).toBe(10); // 1-indexed
      expect(diags[0].column).toBe(4);
      expect(diags[0].severity).toBe('error');
      expect(diags[0].message).toBe('Type error');
    });

    it('returns empty array when no diagnostics', () => {
      vscode.languages.getDiagnostics.mockReturnValue([]);
      expect(ctx.getDiagnostics()).toEqual([]);
    });
  });

  // ─── getDiagnosticsSummary ────────────────────────────────────

  describe('getDiagnosticsSummary', () => {
    it('counts errors and warnings', () => {
      vscode.languages.getDiagnostics.mockReturnValue([
        [
          { fsPath: '/a.ts' },
          [
            { range: { start: { line: 0, character: 0 } }, severity: vscode.DiagnosticSeverity.Error, message: 'e1' },
            { range: { start: { line: 0, character: 0 } }, severity: vscode.DiagnosticSeverity.Warning, message: 'w1' },
            { range: { start: { line: 0, character: 0 } }, severity: vscode.DiagnosticSeverity.Error, message: 'e2' },
          ],
        ],
      ]);

      const summary = ctx.getDiagnosticsSummary();
      expect(summary.errors).toBe(2);
      expect(summary.warnings).toBe(1);
    });
  });

  // ─── buildPromptContext ───────────────────────────────────────

  describe('buildPromptContext', () => {
    it('returns empty array when no context available', async () => {
      vscode.window.activeTextEditor = undefined;
      vscode.languages.getDiagnostics.mockReturnValue([]);
      vscode.extensions.getExtension.mockReturnValue(null);

      const context = await ctx.buildPromptContext();
      expect(context).toEqual([]);
    });
  });
});
