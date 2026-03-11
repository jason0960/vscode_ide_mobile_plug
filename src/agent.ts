import * as vscode from 'vscode';
import * as path from 'path';
import { ContextProvider } from './context';
import {
  FileReadRequest,
  FileWriteRequest,
  FileEditRequest,
  SearchRequest,
  TerminalRunRequest,
} from './types';

/**
 * Agent operations — full IDE control from mobile.
 * Handles file ops, terminal, editor actions, diagnostics, and git.
 */
export class AgentOperations {
  private contextProvider: ContextProvider;
  private managedTerminals: Map<string, vscode.Terminal> = new Map();
  private outputChannel: vscode.LogOutputChannel;

  constructor(contextProvider: ContextProvider, outputChannel: vscode.LogOutputChannel) {
    this.contextProvider = contextProvider;
    this.outputChannel = outputChannel;
  }

  // ─── File Operations ────────────────────────────────────────────

  async readFile(params: FileReadRequest): Promise<{ content: string; lineCount: number }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const content = await this.contextProvider.readFile(absPath, params.startLine, params.endLine);
    return {
      content,
      lineCount: content.split('\n').length,
    };
  }

  async writeFile(params: FileWriteRequest): Promise<{ success: boolean; path: string }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const uri = vscode.Uri.file(absPath);

    // Check if file exists
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      if (!params.createIfMissing) {
        throw new Error(`File not found: ${params.path}. Set createIfMissing=true to create it.`);
      }
    }

    const encoded = Buffer.from(params.content, 'utf8');
    await vscode.workspace.fs.writeFile(uri, encoded);

    return { success: true, path: params.path };
  }

  async createFile(params: { path: string; content: string }): Promise<{ success: boolean; path: string }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const uri = vscode.Uri.file(absPath);

    // Ensure parent directory exists
    const parentUri = vscode.Uri.file(path.dirname(absPath));
    try {
      await vscode.workspace.fs.createDirectory(parentUri);
    } catch {
      // May already exist
    }

    await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf8'));
    return { success: true, path: params.path };
  }

  async deleteFile(params: { path: string }): Promise<{ success: boolean }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const uri = vscode.Uri.file(absPath);
    await vscode.workspace.fs.delete(uri, { recursive: false });
    return { success: true };
  }

  async editFile(params: FileEditRequest): Promise<{ success: boolean; path: string }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const uri = vscode.Uri.file(absPath);

    const doc = await vscode.workspace.openTextDocument(uri);
    const fullText = doc.getText();
    const index = fullText.indexOf(params.oldText);

    if (index === -1) {
      throw new Error(`Could not find the text to replace in ${params.path}`);
    }

    const startPos = doc.positionAt(index);
    const endPos = doc.positionAt(index + params.oldText.length);
    const range = new vscode.Range(startPos, endPos);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, range, params.newText);
    const applied = await vscode.workspace.applyEdit(edit);

    if (applied) {
      await doc.save();
    }

    return { success: applied, path: params.path };
  }

  async searchFiles(params: SearchRequest): Promise<Array<{ path: string; matches: Array<{ line: number; text: string }> }>> {
    const results: Array<{ path: string; matches: Array<{ line: number; text: string }> }> = [];
    const maxResults = params.maxResults || 50;

    // Use workspace.findFiles for file name search
    if (!params.query.includes('\n') && !params.isRegex) {
      // Text search using workspace API
      const pattern = params.includePattern || '**/*';
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 100);

      for (const file of files) {
        try {
          const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
          const lines = content.split('\n');
          const matches: Array<{ line: number; text: string }> = [];

          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(params.query.toLowerCase())) {
              matches.push({ line: i + 1, text: lines[i].trim() });
            }
          }

          if (matches.length > 0) {
            results.push({
              path: vscode.workspace.asRelativePath(file),
              matches: matches.slice(0, 10),
            });
          }
        } catch {
          // Skip binary/unreadable files
        }

        if (results.length >= maxResults) break;
      }
    }

    return results;
  }

  // ─── Terminal Operations ────────────────────────────────────────

  async runCommand(params: TerminalRunRequest): Promise<{ terminalName: string; sent: boolean; output?: string; exitCode?: number }> {
    const name = params.terminalName || 'Mobile Copilot';
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Use child_process.exec to capture output
    try {
      const { exec } = require('child_process');
      const result = await new Promise<{ output: string; exitCode: number }>((resolve) => {
        exec(params.command, {
          cwd: wsFolder || process.cwd(),
          encoding: 'utf-8',
          maxBuffer: 1024 * 512,
          timeout: 55000, // 55s timeout (client has 60s)
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        }, (error: any, stdout: string, stderr: string) => {
          const output = (stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '');
          resolve({
            output: output.trim() || (error ? error.message : '(no output)'),
            exitCode: error?.code ?? 0,
          });
        });
      });

      // Also show in VS Code terminal for desktop visibility
      let terminal = this.managedTerminals.get(name);
      if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({ name });
        this.managedTerminals.set(name, terminal);
      }
      terminal.sendText(params.command);

      return {
        terminalName: name,
        sent: true,
        output: result.output.length > 50000 ? result.output.substring(0, 50000) + '\n... (truncated)' : result.output,
        exitCode: result.exitCode,
      };
    } catch (err: any) {
      // Fallback: just send to VS Code terminal without capture
      let terminal = this.managedTerminals.get(name);
      if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({ name });
        this.managedTerminals.set(name, terminal);
      }
      terminal.show(true);
      terminal.sendText(params.command);

      return { terminalName: name, sent: true, output: `Sent to terminal (output capture failed: ${err.message})` };
    }
  }

  getTerminals() {
    return this.contextProvider.getTerminals();
  }

  // ─── Editor Operations ──────────────────────────────────────────

  async openFile(params: { path: string; line?: number }): Promise<{ success: boolean }> {
    const absPath = this.resolveWorkspacePath(params.path);
    const uri = vscode.Uri.file(absPath);
    const doc = await vscode.workspace.openTextDocument(uri);

    const options: vscode.TextDocumentShowOptions = {};
    if (params.line) {
      const pos = new vscode.Position(params.line - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }

    await vscode.window.showTextDocument(doc, options);
    return { success: true };
  }

  async getActiveEditor(): Promise<{ path: string; language: string; lineCount: number; selection?: string } | null> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;

    const doc = editor.document;
    return {
      path: vscode.workspace.asRelativePath(doc.uri),
      language: doc.languageId,
      lineCount: doc.lineCount,
      selection: editor.selection.isEmpty ? undefined : doc.getText(editor.selection),
    };
  }

  // ─── Diagnostics ────────────────────────────────────────────────

  getDiagnostics() {
    return this.contextProvider.getDiagnostics();
  }

  getDiagnosticsSummary() {
    return this.contextProvider.getDiagnosticsSummary();
  }

  // ─── Git Operations ─────────────────────────────────────────────

  async getGitStatus() {
    return this.contextProvider.getGitStatus();
  }

  async gitDiff(): Promise<string | null> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) return null;

      const git = gitExtension.isActive
        ? gitExtension.exports
        : await gitExtension.activate();

      const api = git.getAPI(1);
      if (!api || api.repositories.length === 0) return null;

      const repo = api.repositories[0];
      const diff = await repo.diff(true);
      return diff || '(no changes)';
    } catch {
      return null;
    }
  }

  // ─── Workspace Info ─────────────────────────────────────────────

  async getWorkspaceInfo() {
    return this.contextProvider.getWorkspaceInfo();
  }

  async getFileTree(maxDepth?: number) {
    return this.contextProvider.getFileTree(maxDepth);
  }

  async listDirectory(dirPath: string) {
    const absPath = this.resolveWorkspacePath(dirPath);
    return this.contextProvider.listDirectory(absPath);
  }

  // ─── Utility ────────────────────────────────────────────────────

  private resolveWorkspacePath(relativePath: string): string {
    // If already absolute, return as-is
    if (path.isAbsolute(relativePath)) {
      return relativePath;
    }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open');
    }

    return path.join(folders[0].uri.fsPath, relativePath);
  }

  /**
   * Clean up managed terminals on deactivation.
   */
  dispose(): void {
    for (const terminal of this.managedTerminals.values()) {
      terminal.dispose();
    }
    this.managedTerminals.clear();
  }
}
