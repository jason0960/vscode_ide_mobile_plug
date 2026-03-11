import * as vscode from 'vscode';
import * as path from 'path';
import {
  FileInfo,
  DiagnosticInfo,
  GitStatusInfo,
  GitChange,
  TerminalInfo,
  WorkspaceInfo,
  ContextAttachment,
} from './types';

/**
 * Provides workspace context to enrich Copilot prompts and
 * supply the mobile client with workspace awareness.
 */
export class ContextProvider {
  /**
   * Get a high-level summary of the workspace.
   */
  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return {
        name: 'No Workspace',
        rootPath: '',
        files: [],
        openEditors: [],
        diagnosticsSummary: { errors: 0, warnings: 0 },
      };
    }

    const root = folders[0];
    const diagnostics = this.getDiagnosticsSummary();
    const openEditors = this.getOpenEditorPaths();
    const gitBranch = await this.getGitBranch();

    return {
      name: root.name,
      rootPath: root.uri.fsPath,
      files: await this.getTopLevelFiles(root.uri),
      openEditors,
      diagnosticsSummary: diagnostics,
      gitBranch: gitBranch || undefined,
    };
  }

  /**
   * List files/folders in a directory (non-recursive).
   */
  async listDirectory(dirPath: string): Promise<FileInfo[]> {
    const uri = vscode.Uri.file(dirPath);
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries
        .map(([name, type]) => ({
          path: path.join(dirPath, name),
          name,
          isDirectory: type === vscode.FileType.Directory,
        }))
        .sort((a, b) => {
          // Folders first, then alphabetical
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
    } catch {
      return [];
    }
  }

  /**
   * Get the workspace file tree (limited depth).
   */
  async getFileTree(maxDepth = 3): Promise<FileInfo[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const result: FileInfo[] = [];
    const ignoreDirs = new Set([
      'node_modules', '.git', 'dist', 'build', '.vscode-test',
      '__pycache__', '.next', '.cache', 'coverage', '.nyc_output',
      'vendor', 'target', 'bin', 'obj',
    ]);

    const walk = async (dirUri: vscode.Uri, depth: number, relativePath: string) => {
      if (depth > maxDepth) return;

      try {
        const entries = await vscode.workspace.fs.readDirectory(dirUri);
        for (const [name, type] of entries) {
          if (ignoreDirs.has(name) && type === vscode.FileType.Directory) continue;
          if (name.startsWith('.') && type === vscode.FileType.Directory) continue;

          const entryPath = relativePath ? `${relativePath}/${name}` : name;
          const entryUri = vscode.Uri.joinPath(dirUri, name);

          result.push({
            path: entryPath,
            name,
            isDirectory: type === vscode.FileType.Directory,
            language: type === vscode.FileType.File ? this.getLanguageId(name) : undefined,
          });

          if (type === vscode.FileType.Directory) {
            await walk(entryUri, depth + 1, entryPath);
          }
        }
      } catch {
        // Ignore permission errors
      }
    };

    await walk(folders[0].uri, 0, '');
    return result;
  }

  /**
   * Read file contents.
   */
  async readFile(filePath: string, startLine?: number, endLine?: number): Promise<string> {
    const uri = vscode.Uri.file(filePath);
    const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, (startLine || 1) - 1);
      const end = endLine ? Math.min(lines.length, endLine) : lines.length;
      return lines.slice(start, end).join('\n');
    }

    return content;
  }

  /**
   * Get all diagnostics (errors, warnings, etc.).
   */
  getDiagnostics(): DiagnosticInfo[] {
    const result: DiagnosticInfo[] = [];
    const allDiags = vscode.languages.getDiagnostics();

    for (const [uri, diags] of allDiags) {
      const relativePath = vscode.workspace.asRelativePath(uri);
      for (const d of diags) {
        result.push({
          file: relativePath,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: this.severityToString(d.severity),
          message: d.message,
          source: d.source,
          code: typeof d.code === 'object' ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined,
        });
      }
    }

    return result;
  }

  /**
   * Get a summary of diagnostics counts.
   */
  getDiagnosticsSummary(): { errors: number; warnings: number } {
    const diags = this.getDiagnostics();
    return {
      errors: diags.filter((d) => d.severity === 'error').length,
      warnings: diags.filter((d) => d.severity === 'warning').length,
    };
  }

  /**
   * Get paths of currently open editors.
   */
  getOpenEditorPaths(): string[] {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => {
        const input = tab.input;
        if (input instanceof vscode.TabInputText) {
          return vscode.workspace.asRelativePath(input.uri);
        }
        return null;
      })
      .filter((p): p is string => p !== null);
  }

  /**
   * Get the active file content and path.
   */
  getActiveEditorContext(): ContextAttachment | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const doc = editor.document;
    const relativePath = vscode.workspace.asRelativePath(doc.uri);

    // If there's a selection, include just that; otherwise first 200 lines
    let content: string;
    if (!editor.selection.isEmpty) {
      content = doc.getText(editor.selection);
    } else {
      const lines = doc.lineCount;
      const endLine = Math.min(lines, 200);
      content = doc.getText(new vscode.Range(0, 0, endLine, 0));
      if (lines > 200) {
        content += `\n... (${lines - 200} more lines)`;
      }
    }

    return {
      type: 'file',
      name: relativePath,
      content: `Language: ${doc.languageId}\n\n${content}`,
    };
  }

  /**
   * Get git status using the built-in Git extension.
   */
  async getGitStatus(): Promise<GitStatusInfo | null> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) return null;

      const git = gitExtension.isActive
        ? gitExtension.exports
        : await gitExtension.activate();

      const api = git.getAPI(1);
      if (!api || api.repositories.length === 0) return null;

      const repo = api.repositories[0];
      const head = repo.state.HEAD;

      const changes: GitChange[] = [
        ...repo.state.workingTreeChanges.map((c: any) => ({
          path: vscode.workspace.asRelativePath(c.uri),
          status: this.gitStatusToString(c.status),
        })),
        ...repo.state.indexChanges.map((c: any) => ({
          path: vscode.workspace.asRelativePath(c.uri),
          status: this.gitStatusToString(c.status),
        })),
      ];

      return {
        branch: head?.name || 'HEAD',
        ahead: head?.ahead || 0,
        behind: head?.behind || 0,
        changes,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get git branch name.
   */
  async getGitBranch(): Promise<string | null> {
    const status = await this.getGitStatus();
    return status?.branch || null;
  }

  /**
   * Get terminal info.
   */
  getTerminals(): TerminalInfo[] {
    return vscode.window.terminals.map((t, i) => ({
      id: i,
      name: t.name,
      isActive: vscode.window.activeTerminal === t,
    }));
  }

  /**
   * Build a full context object for a Copilot prompt.
   */
  async buildPromptContext(): Promise<ContextAttachment[]> {
    const context: ContextAttachment[] = [];

    // Active file
    const activeEditor = this.getActiveEditorContext();
    if (activeEditor) {
      context.push(activeEditor);
    }

    // Diagnostics (if there are errors)
    const diags = this.getDiagnostics().filter((d) => d.severity === 'error');
    if (diags.length > 0) {
      context.push({
        type: 'diagnostics',
        name: `${diags.length} errors`,
        content: diags
          .slice(0, 20) // Limit to 20 most relevant
          .map((d) => `${d.file}:${d.line} [${d.severity}] ${d.message}`)
          .join('\n'),
      });
    }

    // Git status
    const git = await this.getGitStatus();
    if (git && git.changes.length > 0) {
      context.push({
        type: 'git',
        name: `${git.branch} (${git.changes.length} changes)`,
        content: `Branch: ${git.branch}\nChanges:\n${git.changes
          .map((c) => `  ${c.status}: ${c.path}`)
          .join('\n')}`,
      });
    }

    return context;
  }

  // ─── Private helpers ──────────────────────────────────────────

  private async getTopLevelFiles(rootUri: vscode.Uri): Promise<FileInfo[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(rootUri);
      return entries
        .filter(([name]) => !name.startsWith('.'))
        .slice(0, 50)
        .map(([name, type]) => ({
          path: name,
          name,
          isDirectory: type === vscode.FileType.Directory,
        }));
    } catch {
      return [];
    }
  }

  private severityToString(severity: vscode.DiagnosticSeverity): DiagnosticInfo['severity'] {
    switch (severity) {
      case vscode.DiagnosticSeverity.Error:
        return 'error';
      case vscode.DiagnosticSeverity.Warning:
        return 'warning';
      case vscode.DiagnosticSeverity.Information:
        return 'info';
      case vscode.DiagnosticSeverity.Hint:
        return 'hint';
    }
  }

  private gitStatusToString(status: number): GitChange['status'] {
    // Git extension status codes
    switch (status) {
      case 5: return 'modified';
      case 1: return 'added';
      case 6: return 'deleted';
      case 3: return 'renamed';
      case 7: return 'untracked';
      default: return 'modified';
    }
  }

  private getLanguageId(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const langMap: Record<string, string> = {
      '.ts': 'typescript', '.tsx': 'typescriptreact',
      '.js': 'javascript', '.jsx': 'javascriptreact',
      '.py': 'python', '.rb': 'ruby',
      '.go': 'go', '.rs': 'rust',
      '.java': 'java', '.kt': 'kotlin',
      '.cs': 'csharp', '.cpp': 'cpp', '.c': 'c',
      '.html': 'html', '.css': 'css', '.scss': 'scss',
      '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
      '.md': 'markdown', '.sh': 'shellscript',
      '.sql': 'sql', '.xml': 'xml',
      '.swift': 'swift', '.dart': 'dart',
    };
    return langMap[ext] || 'plaintext';
  }
}
