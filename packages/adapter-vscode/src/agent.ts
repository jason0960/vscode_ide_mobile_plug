import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ContextProvider } from './context';
import type {
  FileReadRequest,
  FileWriteRequest,
  FileEditRequest,
  SearchRequest,
  TerminalRunRequest,
} from '@mobile-copilot/protocol';

/** Max files per git restore/revert operation to prevent event-loop blocking */
const MAX_FILES_PER_OPERATION = 100;
/** Max diff size (5 MB) to prevent memory exhaustion */
const MAX_DIFF_SIZE = 5 * 1024 * 1024;

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

    if (!params.query.includes('\n') && !params.isRegex) {
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

  // ── Command Safety ──────────────────────────────────────────────

  private static readonly BLOCKED_COMMANDS = [
    /\brm\s+(-rf?|--recursive)\s+[\/~]/, // rm -rf / or ~
    /\bmkfs\b/, /\bdd\b.*\bof=\/dev/, /\bformat\b/,
    /\bcurl\b.*\|\s*(ba)?sh/, // curl | sh
    /\bwget\b.*\|\s*(ba)?sh/,
    /\bchmod\s+777\s+\//, // chmod 777 /
    /\bchown\b.*\s+\//, // chown / (root filesystem)
    /\breboot\b/, /\bshutdown\b/, /\bhalt\b/,
    /\b(nc|ncat|netcat)\b.*-[el]/, // reverse shells
    /\beval\b/, /\bsource\s+\/dev\/tcp/,
  ];

  private validateCommand(command: string): void {
    // Block empty commands
    if (!command || !command.trim()) {
      throw new Error('Empty command');
    }
    // Block excessively long commands
    if (command.length > 2000) {
      throw new Error('Command too long (max 2000 chars)');
    }
    // Block dangerous patterns
    for (const pattern of AgentOperations.BLOCKED_COMMANDS) {
      if (pattern.test(command)) {
        throw new Error(`Blocked: command matches dangerous pattern`);
      }
    }
  }

  // ─── Terminal Operations ────────────────────────────────────────

  async runCommand(params: TerminalRunRequest): Promise<{ terminalName: string; sent: boolean; output?: string; exitCode?: number }> {
    const name = params.terminalName || 'Mobile Copilot';
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.validateCommand(params.command);

    try {
      const { exec } = require('child_process');
      const result = await new Promise<{ output: string; exitCode: number }>((resolve) => {
        exec(params.command, {
          cwd: wsFolder || process.cwd(),
          encoding: 'utf-8',
          maxBuffer: 1024 * 512,
          timeout: 55000,
          env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        }, (error: any, stdout: string, stderr: string) => {
          const output = (stdout || '') + (stderr ? (stdout ? '\n' : '') + stderr : '');
          resolve({
            output: output.trim() || (error ? error.message : '(no output)'),
            exitCode: error?.code ?? 0,
          });
        });
      });

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

  /**
   * Restore (discard) working-tree changes for the given files.
   * Untracked files (`??`) are deleted; tracked files are `git restore`d.
   * Every path is validated through `resolveWorkspacePath` before use.
   */
  async gitRestoreFiles(files: string[]): Promise<{ restored: number; files: string[]; message?: string }> {
    if (!files || files.length === 0) {
      return { restored: 0, files: [], message: 'No files specified' };
    }
    if (files.length > MAX_FILES_PER_OPERATION) {
      throw new Error(`Too many files (${files.length}). Maximum is ${MAX_FILES_PER_OPERATION}`);
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) throw new Error('No workspace folder open');
    const wsRoot = wsFolder.uri.fsPath;

    const results: string[] = [];
    for (const filePath of files) {
      // Validate every path through the battle-tested resolver
      this.resolveWorkspacePath(filePath);

      try {
        const status = execFileSync('git', ['status', '--porcelain', '--', filePath], {
          cwd: wsRoot, encoding: 'utf-8',
        }).trim();

        if (status.startsWith('??')) {
          // Untracked → delete.  Use the resolved absolute path.
          const absPath = this.resolveWorkspacePath(filePath);
          fs.unlinkSync(absPath);
        } else {
          execFileSync('git', ['restore', '--', filePath], { cwd: wsRoot });
          try { execFileSync('git', ['restore', '--staged', '--', filePath], { cwd: wsRoot }); } catch { /* ignore */ }
        }
        results.push(filePath);
      } catch (err: any) {
        this.outputChannel.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
      }
    }
    return { restored: results.length, files: results };
  }

  /**
   * Selectively revert specific diff hunks from a file.
   * The filePath is validated; diff headers are regenerated from the
   * validated path (never trusting user-supplied headers) to prevent
   * targeting files outside the workspace.
   */
  async gitRevertHunks(
    filePath: string,
    hunkIndices: number[],
    diff: string,
  ): Promise<{ success: boolean; reverted?: number; message?: string }> {
    if (!filePath || !hunkIndices?.length || !diff) {
      return { success: false, message: 'Missing required parameters (filePath, hunkIndices, diff)' };
    }

    // --- Input validation ---
    if (filePath.includes('\n') || filePath.includes('\r')) {
      throw new Error('Invalid filePath: contains newline characters');
    }
    if (diff.length > MAX_DIFF_SIZE) {
      throw new Error(`Diff too large (${diff.length} bytes). Maximum is ${MAX_DIFF_SIZE}`);
    }

    // Path-traversal check through the tested resolver
    this.resolveWorkspacePath(filePath);

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) throw new Error('No workspace folder open');
    const wsRoot = wsFolder.uri.fsPath;

    // Parse the unified diff into header lines + individual hunks
    const lines = diff.split('\n');
    const hunks: { header: string; lines: string[] }[] = [];
    let currentHunk: { header: string; lines: string[] } | null = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk) {
        currentHunk.lines.push(line);
      }
      // Intentionally skip all header lines from user input
    }
    if (currentHunk) hunks.push(currentHunk);

    // Always regenerate headers from the VALIDATED path — never trust user input
    const headerLines = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
    ];

    // Build a patch containing only the selected hunks
    const patchLines = [...headerLines];
    for (const idx of hunkIndices) {
      if (idx >= 0 && idx < hunks.length) {
        patchLines.push(hunks[idx].header);
        patchLines.push(...hunks[idx].lines);
      }
    }

    const tmpFile = path.join(
      os.tmpdir(),
      `mobile-copilot-revert-${crypto.randomBytes(8).toString('hex')}.patch`,
    );
    fs.writeFileSync(tmpFile, patchLines.join('\n') + '\n');

    try {
      execFileSync('git', ['apply', '--reverse', tmpFile], {
        cwd: wsRoot, encoding: 'utf-8',
      });
      return { success: true, reverted: hunkIndices.length };
    } catch {
      // Fallback: try with --3way for better conflict handling
      try {
        execFileSync('git', ['apply', '--reverse', '--3way', tmpFile], {
          cwd: wsRoot, encoding: 'utf-8',
        });
        return { success: true, reverted: hunkIndices.length };
      } catch (err2: any) {
        this.outputChannel.warn(`[Git] revertHunks failed for ${filePath}: ${err2.message}`);
        return { success: false, message: 'Failed to apply reverse patch' };
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  /**
   * Restore (discard) working-tree changes — typically agent-modified files.
   * Every path is validated through `resolveWorkspacePath`.
   */
  async gitRestoreChanges(files: string[]): Promise<{ restored: number; files: string[] }> {
    if (!files || files.length === 0) {
      return { restored: 0, files: [] };
    }
    if (files.length > MAX_FILES_PER_OPERATION) {
      throw new Error(`Too many files (${files.length}). Maximum is ${MAX_FILES_PER_OPERATION}`);
    }

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) throw new Error('No workspace folder open');
    const wsRoot = wsFolder.uri.fsPath;

    const results: string[] = [];
    for (const filePath of files) {
      this.resolveWorkspacePath(filePath);
      try {
        execFileSync('git', ['restore', '--', filePath], { cwd: wsRoot });
        results.push(filePath);
      } catch (err: any) {
        this.outputChannel.warn(`[Git] Failed to restore ${filePath}: ${err.message}`);
      }
    }
    return { restored: results.length, files: results };
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

  resolveWorkspacePath(relativePath: string): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error('No workspace folder open');
    }

    const wsRoot = folders[0].uri.fsPath;
    // Always resolve relative to workspace — never allow absolute paths
    const resolved = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(wsRoot, relativePath);
    const canonical = path.resolve(resolved);

    // Ensure the resolved path is within the workspace
    if (!canonical.startsWith(wsRoot + path.sep) && canonical !== wsRoot) {
      throw new Error(`Path traversal blocked: ${relativePath} resolves outside workspace`);
    }

    return canonical;
  }

  dispose(): void {
    for (const terminal of this.managedTerminals.values()) {
      terminal.dispose();
    }
    this.managedTerminals.clear();
  }
}
