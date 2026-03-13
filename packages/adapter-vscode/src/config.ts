import * as vscode from 'vscode';
import type { IConfigProvider } from '@mobile-copilot/adapter-core';

/**
 * VS Code implementation of IConfigProvider.
 * Reads from `mobileCopilot.*` workspace configuration.
 */
export class VsCodeConfig implements IConfigProvider {
  get<T>(key: string, defaultValue?: T): T | undefined {
    const config = vscode.workspace.getConfiguration('mobileCopilot');
    return defaultValue !== undefined
      ? config.get<T>(key, defaultValue)
      : config.get<T>(key);
  }
}
