import * as vscode from 'vscode';
import type { ILogger } from '@mobile-copilot/adapter-core';

/**
 * VS Code implementation of ILogger using a LogOutputChannel.
 */
export class VsCodeLogger implements ILogger {
  public readonly channel: vscode.LogOutputChannel;

  constructor(name: string = 'Mobile Copilot') {
    this.channel = vscode.window.createOutputChannel(name, { log: true });
  }

  info(message: string): void {
    this.channel.info(message);
  }

  warn(message: string): void {
    this.channel.warn(message);
  }

  error(message: string): void {
    this.channel.error(message);
  }

  debug(message: string): void {
    this.channel.debug(message);
  }
}
