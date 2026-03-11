import * as vscode from 'vscode';
import { ChatMessage, ContextAttachment } from './types';

/**
 * Bridge to the VS Code Language Model API (vscode.lm).
 * Sends prompts to Copilot and streams responses back.
 */
export class CopilotBridge {
  private model: vscode.LanguageModelChat | null = null;
  private outputChannel: vscode.LogOutputChannel;

  constructor(outputChannel: vscode.LogOutputChannel) {
    this.outputChannel = outputChannel;
  }

  /**
   * Select and cache a Copilot language model.
   */
  async selectModel(family?: string): Promise<vscode.LanguageModelChat> {
    const config = vscode.workspace.getConfiguration('mobileCopilot');
    const preferredFamily = family || config.get<string>('modelFamily', 'gpt-4o');

    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: preferredFamily,
    });

    if (models.length === 0) {
      // Fallback: try any copilot model
      const fallback = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (fallback.length === 0) {
        throw new Error(
          'No Copilot language models available. Ensure GitHub Copilot is installed and active.'
        );
      }
      this.model = fallback[0];
      this.outputChannel.info(`Selected fallback model: ${this.model.name} (${this.model.family})`);
      return this.model;
    }

    this.model = models[0];
    this.outputChannel.info(`Selected model: ${this.model.name} (${this.model.family})`);
    return this.model;
  }

  /**
   * Get the current model, selecting one if needed.
   */
  async getModel(): Promise<vscode.LanguageModelChat> {
    if (!this.model) {
      await this.selectModel();
    }
    return this.model!;
  }

  /**
   * List available models.
   */
  async listModels(): Promise<Array<{ name: string; family: string; vendor: string; maxInputTokens: number }>> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m) => ({
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      maxInputTokens: m.maxInputTokens,
    }));
  }

  /**
   * Send a prompt with history and context, streaming the response.
   *
   * @param prompt - The user's message
   * @param history - Conversation history
   * @param context - Attached workspace context
   * @param onChunk - Callback for each streaming chunk
   * @param token - Cancellation token
   * @returns The full response text
   */
  async sendPrompt(
    prompt: string,
    history: ChatMessage[] = [],
    context: ContextAttachment[] = [],
    onChunk: (chunk: string) => void,
    token?: vscode.CancellationToken
  ): Promise<string> {
    const model = await this.getModel();
    const messages = this.buildMessages(prompt, history, context);

    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    try {
      const response = await model.sendRequest(messages, {}, cancellationToken);
      let fullText = '';

      for await (const chunk of response.text) {
        fullText += chunk;
        onChunk(chunk);
      }

      return fullText;
    } catch (err: any) {
      if (err instanceof vscode.LanguageModelError) {
        const errMsg = `Copilot error [${err.code}]: ${err.message}`;
        this.outputChannel.error(errMsg);

        if (err.code === 'NoPermissions') {
          throw new Error(
            '⚠️ Authorization Required — VS Code is showing a permission dialog on your desktop. ' +
            'Please go to your computer and click "Allow" to grant Mobile Copilot access to the language model. ' +
            'This only needs to be done once.'
          );
        }
        if (err.code === 'Blocked') {
          throw new Error(
            '🚫 Request Blocked — Copilot\'s content filter blocked this request. Try rephrasing your prompt.'
          );
        }
        if (err.code === 'NotFound') {
          throw new Error(
            '❌ Model Not Found — The selected model is not available. Check your Copilot subscription ' +
            'or switch to a different model in VS Code Settings.'
          );
        }

        throw new Error(`❌ Copilot Error — ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Build the message array for the LM API.
   */
  private buildMessages(
    prompt: string,
    history: ChatMessage[],
    context: ContextAttachment[]
  ): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    // System prompt with workspace context
    let systemContent =
      'You are a helpful coding assistant connected via Mobile Copilot. ' +
      'The user is prompting you from their mobile device and has full access to their VS Code workspace. ' +
      'You can help with code, answer questions, explain concepts, and assist with development tasks. ' +
      'Format responses with markdown. Use code blocks with language identifiers for code snippets.';

    if (context.length > 0) {
      systemContent += '\n\n--- WORKSPACE CONTEXT ---\n';
      for (const ctx of context) {
        systemContent += `\n[${ctx.type.toUpperCase()}: ${ctx.name}]\n${ctx.content}\n`;
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(systemContent));

    // Conversation history
    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else if (msg.role === 'assistant') {
        messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }

    // Current prompt
    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    return messages;
  }

  /**
   * Count tokens for a string using the current model.
   */
  async countTokens(text: string): Promise<number> {
    const model = await this.getModel();
    return model.countTokens(text);
  }

  /**
   * Reset the cached model (e.g., after model change).
   */
  resetModel(): void {
    this.model = null;
  }

  // ─── Copilot Chat Passthrough Mode ──────────────────────────────

  /**
   * Send a prompt directly to the real Copilot Chat panel.
   * This gives the EXACT same experience as typing in the chat —
   * full agent mode with tools, file edits, terminal commands, etc.
   *
   * The prompt is injected into the Copilot Chat input and auto-submitted.
   * Response capture is done via workspace event monitoring (file changes,
   * diagnostics, etc.), not by reading the chat panel output.
   */
  async sendToChat(prompt: string): Promise<{ sent: boolean; error?: string }> {
    try {
      // Open the Copilot Chat panel with the prompt and auto-submit
      // isPartialQuery: false = auto-submit (hits Enter)
      // isPartialQuery: true  = just fills in the input without submitting
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        query: prompt,
        isPartialQuery: false,
      });

      this.outputChannel.info(`[Passthrough] Sent to Copilot Chat: ${prompt.substring(0, 100)}...`);
      return { sent: true };
    } catch (err: any) {
      this.outputChannel.error(`[Passthrough] Failed to send to Copilot Chat: ${err.message}`);
      return { sent: false, error: err.message };
    }
  }

  /**
   * Send a prompt to Copilot Chat in agent mode (with @workspace or similar).
   * Prefixes the prompt to trigger agent behavior if not already prefixed.
   */
  async sendToChatAgent(prompt: string): Promise<{ sent: boolean; error?: string }> {
    // If the prompt doesn't already have an @-mention, we can optionally prefix it.
    // The user's raw prompt goes directly — Copilot Chat in agent mode handles everything.
    return this.sendToChat(prompt);
  }
}
