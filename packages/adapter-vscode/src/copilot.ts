import * as vscode from 'vscode';
import type { ChatMessage, ContextAttachment } from '@mobile-copilot/protocol';

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

  async selectModel(family?: string): Promise<vscode.LanguageModelChat> {
    const config = vscode.workspace.getConfiguration('mobileCopilot');
    const preferredFamily = family || config.get<string>('modelFamily', 'gpt-4o');

    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: preferredFamily,
    });

    if (models.length === 0) {
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

  async getModel(): Promise<vscode.LanguageModelChat> {
    if (!this.model) {
      await this.selectModel();
    }
    return this.model!;
  }

  async listModels(): Promise<Array<{ name: string; family: string; vendor: string; maxInputTokens: number }>> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m) => ({
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      maxInputTokens: m.maxInputTokens,
    }));
  }

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
            'Please go to your computer and click "Allow" to grant AgentDeck access to the language model. ' +
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

  private buildMessages(
    prompt: string,
    history: ChatMessage[],
    context: ContextAttachment[]
  ): vscode.LanguageModelChatMessage[] {
    const messages: vscode.LanguageModelChatMessage[] = [];

    let systemContent =
      'You are a helpful coding assistant connected via AgentDeck. ' +
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

    for (const msg of history) {
      if (msg.role === 'user') {
        messages.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else if (msg.role === 'assistant') {
        messages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(prompt));

    return messages;
  }

  async countTokens(text: string): Promise<number> {
    const model = await this.getModel();
    return model.countTokens(text);
  }
}
