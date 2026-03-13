import * as vscode from 'vscode';
import type { ChatMessage, ContextAttachment } from '@mobile-copilot/protocol';
import { ContextProvider } from './context';

/**
 * Chat Participant that acts as the relay between mobile and Copilot.
 *
 * When user types `@mobile <prompt>` in the Chat panel (or our extension
 * injects it), this handler:
 *  1. Calls the Copilot LM with the prompt + workspace context
 *  2. Streams the response into the Chat panel (visible in VS Code)
 *  3. Simultaneously relays each chunk to the mobile client via a callback
 */

export type MobileChunkCallback = (chunk: string) => void;
export type MobileRequestStartCallback = (requestId: string) => void;
export type MobileRequestEndCallback = (requestId: string, fullText: string) => void;

let chunkCallback: MobileChunkCallback | null = null;
let requestStartCallback: MobileRequestStartCallback | null = null;
let requestEndCallback: MobileRequestEndCallback | null = null;

export function setMobileCallbacks(
  onChunk: MobileChunkCallback,
  onRequestStart: MobileRequestStartCallback,
  onRequestEnd: MobileRequestEndCallback
): void {
  chunkCallback = onChunk;
  requestStartCallback = onRequestStart;
  requestEndCallback = onRequestEnd;
}

let currentMobileRequestId: string | null = null;

export function setCurrentMobileRequestId(id: string | null): void {
  currentMobileRequestId = id;
}

export function getCurrentMobileRequestId(): string | null {
  return currentMobileRequestId;
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  outputChannel: vscode.LogOutputChannel
): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ) => {
    const prompt = request.prompt;
    const requestId = currentMobileRequestId || `local_${Date.now()}`;
    const isFromMobile = currentMobileRequestId !== null;

    outputChannel.info(
      `[Participant] Handling request (mobile=${isFromMobile}): ${prompt.substring(0, 100)}...`
    );

    if (isFromMobile && requestStartCallback) {
      requestStartCallback(requestId);
    }

    const messages: vscode.LanguageModelChatMessage[] = [];

    const systemPrompt =
      'You are a powerful coding assistant running inside VS Code via the Mobile Copilot extension. ' +
      'The user may be prompting from their mobile device. ' +
      'You have full awareness of the workspace — the file tree, open editors, diagnostics, and git status are provided below. ' +
      'Help with code, explain concepts, refactor, debug, and more. ' +
      'Format responses with markdown. Use code blocks with language identifiers.\n\n' +
      'IMPORTANT: When the user asks you to edit files, create files, run commands, or make changes, ' +
      'provide the exact code or commands. The user can apply them through the IDE.';

    messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));

    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        let responseText = '';
        for (const part of turn.response) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            responseText += part.value.value;
          }
        }
        if (responseText) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
        }
      }
    }

    // ── Rich workspace context ──
    const ctxProvider = new ContextProvider();
    const contextParts: string[] = [];

    try {
      const wsInfo = await ctxProvider.getWorkspaceInfo();
      contextParts.push(`[Workspace: ${wsInfo.name}]`);
      if (wsInfo.gitBranch) {
        contextParts.push(`[Git branch: ${wsInfo.gitBranch}]`);
      }

      const fileTree = await ctxProvider.getFileTree(3);
      if (fileTree.length > 0) {
        const treeStr = fileTree
          .map(f => `${f.isDirectory ? '📁' : '  '} ${f.path}`)
          .join('\n');
        contextParts.push(`[Project structure (${fileTree.length} items):\n${treeStr}\n]`);
      }
    } catch (e: any) {
      outputChannel.warn(`[Participant] Could not get workspace info: ${e.message}`);
    }

    try {
      const openEditors = ctxProvider.getOpenEditorPaths();
      if (openEditors.length > 0) {
        contextParts.push(`[Open editors: ${openEditors.join(', ')}]`);
      }
    } catch { /* ignore */ }

    try {
      const diags = ctxProvider.getDiagnostics();
      const errors = diags.filter(d => d.severity === 'error');
      const warnings = diags.filter(d => d.severity === 'warning');
      if (errors.length > 0 || warnings.length > 0) {
        const diagStr = [...errors, ...warnings].slice(0, 15)
          .map(d => `${d.file}:${d.line} [${d.severity}] ${d.message}`)
          .join('\n');
        contextParts.push(`[Diagnostics (${errors.length} errors, ${warnings.length} warnings):\n${diagStr}\n]`);
      }
    } catch { /* ignore */ }

    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      const filePath = vscode.workspace.asRelativePath(activeEditor.document.uri);
      const docText = activeEditor.document.getText();
      const truncated = docText.length > 4000
        ? docText.substring(0, 4000) + '\n... (truncated)'
        : docText;
      contextParts.push(`[Active file: ${filePath}\n\`\`\`\n${truncated}\n\`\`\`]`);

      const selection = activeEditor.selection;
      if (!selection.isEmpty) {
        const selectedText = activeEditor.document.getText(selection);
        contextParts.push(`[Selected code (${filePath} L${selection.start.line + 1}-${selection.end.line + 1}):\n\`\`\`\n${selectedText}\n\`\`\`]`);
      }
    }

    try {
      const promptContext = await ctxProvider.buildPromptContext();
      const gitCtx = promptContext.find(c => c.type === 'git');
      if (gitCtx) {
        contextParts.push(`[Git status:\n${gitCtx.content}\n]`);
      }
    } catch { /* ignore */ }

    if (contextParts.length > 0) {
      messages.push(vscode.LanguageModelChatMessage.User(
        'Here is the current workspace context:\n\n' + contextParts.join('\n\n')
      ));
    }

    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    const model = request.model;

    try {
      const chatResponse = await model.sendRequest(messages, {}, token);
      let fullText = '';

      for await (const fragment of chatResponse.text) {
        fullText += fragment;
        stream.markdown(fragment);

        if (isFromMobile && chunkCallback) {
          chunkCallback(fragment);
        }
      }

      if (isFromMobile && requestEndCallback) {
        requestEndCallback(requestId, fullText);
      }

      outputChannel.info(
        `[Participant] Response complete (${fullText.length} chars, mobile=${isFromMobile})`
      );
    } catch (err: any) {
      const errMsg = `Error: ${err.message || 'Unknown error'}`;
      stream.markdown(errMsg);

      if (isFromMobile && requestEndCallback) {
        requestEndCallback(requestId, errMsg);
      }

      outputChannel.error(`[Participant] Error: ${err.message}`);
    } finally {
      if (isFromMobile) {
        currentMobileRequestId = null;
      }
    }
  };

  const participant = vscode.chat.createChatParticipant('mobile-copilot.relay', handler);
  participant.iconPath = new vscode.ThemeIcon('device-mobile');

  context.subscriptions.push(participant);

  outputChannel.info('[Participant] @mobile chat participant registered');
  return participant;
}
