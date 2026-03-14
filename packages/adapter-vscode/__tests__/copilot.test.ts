/**
 * CopilotBridge — unit tests
 *
 * Covers: selectModel, listModels, buildMessages, sendToChat error handling.
 * LLM calls are fully mocked since vscode.lm is not available outside VS Code.
 *
 * The vscode module is mocked via __mocks__/vscode.ts.
 */
jest.mock('vscode');
const vscode = require('vscode');

import { CopilotBridge } from '../src/copilot';

// ─── Shared mock model ──────────────────────────────────────────

const mockModel = {
  name: 'gpt-4o',
  family: 'gpt-4o',
  vendor: 'copilot',
  maxInputTokens: 128000,
  sendRequest: jest.fn(),
  countTokens: jest.fn().mockResolvedValue(42),
};

describe('CopilotBridge', () => {
  let bridge: CopilotBridge;
  let mockOutputChannel: any;

  beforeEach(() => {
    mockOutputChannel = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      appendLine: jest.fn(),
      trace: jest.fn(),
    };

    bridge = new CopilotBridge(mockOutputChannel);

    // Reset mocks
    vscode.lm.selectChatModels.mockResolvedValue([mockModel]);
    mockModel.sendRequest.mockReset();
    mockModel.countTokens.mockResolvedValue(42);
  });

  // ─── selectModel ──────────────────────────────────────────────

  describe('selectModel', () => {
    it('selects a model from the preferred family', async () => {
      const model = await bridge.selectModel('gpt-4o');
      expect(model).toBe(mockModel);
      expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({
        vendor: 'copilot',
        family: 'gpt-4o',
      });
    });

    it('falls back when preferred family not available', async () => {
      vscode.lm.selectChatModels
        .mockResolvedValueOnce([]) // preferred = empty
        .mockResolvedValueOnce([mockModel]); // fallback

      const model = await bridge.selectModel('claude-sonnet');
      expect(model).toBe(mockModel);
    });

    it('throws when no models at all', async () => {
      vscode.lm.selectChatModels.mockResolvedValue([]);

      await expect(bridge.selectModel()).rejects.toThrow(
        /No Copilot language models available/,
      );
    });
  });

  // ─── listModels ───────────────────────────────────────────────

  describe('listModels', () => {
    it('returns model metadata', async () => {
      const models = await bridge.listModels();
      expect(models).toEqual([
        { name: 'gpt-4o', family: 'gpt-4o', vendor: 'copilot', maxInputTokens: 128000 },
      ]);
    });
  });

  // ─── sendPrompt ───────────────────────────────────────────────

  describe('sendPrompt', () => {
    it('streams chunks and returns full text', async () => {
      // Mock sendRequest to return an async iterable
      mockModel.sendRequest.mockResolvedValue({
        text: (async function* () {
          yield 'Hello';
          yield ' world';
        })(),
      });

      const chunks: string[] = [];
      const result = await bridge.sendPrompt('test prompt', [], [], (c) => chunks.push(c));

      expect(result).toBe('Hello world');
      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('includes context and history in messages', async () => {
      mockModel.sendRequest.mockResolvedValue({
        text: (async function* () { yield 'ok'; })(),
      });

      await bridge.sendPrompt(
        'question',
        [{ role: 'user', content: 'prev', timestamp: 0 }],
        [{ type: 'file', name: 'test.ts', content: 'code' }],
        () => {},
      );

      expect(mockModel.sendRequest).toHaveBeenCalledTimes(1);
      const messages = mockModel.sendRequest.mock.calls[0][0];
      // System message + history + current prompt
      expect(messages.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── countTokens ──────────────────────────────────────────────

  describe('countTokens', () => {
    it('returns token count from model', async () => {
      // Force model selection
      await bridge.selectModel();
      const count = await bridge.countTokens('Hello world');
      expect(count).toBe(42);
    });
  });

  // ─── resetModel ───────────────────────────────────────────────

  describe('resetModel', () => {
    it('clears cached model', async () => {
      await bridge.selectModel();
      bridge.resetModel();
      // Clear call count, then re-select
      vscode.lm.selectChatModels.mockClear();
      await bridge.selectModel();
      expect(vscode.lm.selectChatModels).toHaveBeenCalled();
    });
  });

  // ─── sendToChat ───────────────────────────────────────────────

  describe('sendToChat', () => {
    it('returns success when command executes', async () => {
      vscode.commands.executeCommand.mockResolvedValue(undefined);
      const result = await bridge.sendToChat('hello');
      expect(result.sent).toBe(true);
    });

    it('returns error when command fails', async () => {
      vscode.commands.executeCommand.mockRejectedValue(new Error('No chat'));
      const result = await bridge.sendToChat('hello');
      expect(result.sent).toBe(false);
      expect(result.error).toBe('No chat');
    });
  });
});
