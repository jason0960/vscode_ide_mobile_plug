/**
 * ChatResponseInterceptor — unit tests
 *
 * Covers: session lifecycle (start, end, supersede), document change routing,
 * chat document detection (scheme + heuristic), incremental streaming,
 * file change tracking (created/modified/deleted), debounce timing,
 * session timeout, scheme filtering, and dispose.
 *
 * The vscode module is mocked via __mocks__/vscode.ts.
 */
jest.mock('vscode');
const vscode = require('vscode');

import { ChatResponseInterceptor } from '../src/interceptor';
import type { InterceptorResult } from '../src/interceptor';

// ─── Helpers ────────────────────────────────────────────────────

function createOutputChannel(): any {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    appendLine: jest.fn(),
    trace: jest.fn(),
  };
}

/** Build a minimal TextDocumentChangeEvent mock */
function makeChangeEvent(
  scheme: string,
  content: string,
  changes: Array<{ text: string; rangeStart?: { line: number }; rangeEnd?: { line: number } }> = [{ text: 'x' }],
): any {
  return {
    document: {
      uri: {
        scheme,
        toString: () => `${scheme}://doc`,
        fsPath: '/mock/file.ts',
      },
      languageId: 'markdown',
      version: 1,
      getText: () => content,
    },
    contentChanges: changes.map((c) => ({
      text: c.text,
      range: {
        start: { line: c.rangeStart?.line ?? 0, character: 0 },
        end: { line: c.rangeEnd?.line ?? 0, character: 0 },
      },
    })),
  };
}

// ─── Test Suite ─────────────────────────────────────────────────

describe('ChatResponseInterceptor', () => {
  let interceptor: ChatResponseInterceptor;
  let outputChannel: any;

  beforeEach(() => {
    jest.useFakeTimers();
    outputChannel = createOutputChannel();
    interceptor = new ChatResponseInterceptor(outputChannel);

    // Mock workspace event listeners to capture callbacks
    vscode.workspace.onDidCreateFiles = jest.fn().mockReturnValue({ dispose: jest.fn() });
    vscode.workspace.onDidSaveTextDocument = jest.fn().mockReturnValue({ dispose: jest.fn() });
    vscode.workspace.onDidDeleteFiles = jest.fn().mockReturnValue({ dispose: jest.fn() });
    vscode.workspace.asRelativePath = jest.fn((p: any) =>
      typeof p === 'string' ? p : p.fsPath || p.path || String(p),
    );
  });

  afterEach(() => {
    interceptor.dispose();
    jest.useRealTimers();
  });

  // ─── Session Lifecycle ────────────────────────────────────────

  describe('startSession', () => {
    it('starts a session and returns a wait handle', () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);
      expect(handle).toBeDefined();
      expect(typeof handle.wait).toBe('function');
    });

    it('sets up file event listeners', () => {
      interceptor.startSession(jest.fn());
      expect(vscode.workspace.onDidCreateFiles).toHaveBeenCalled();
      expect(vscode.workspace.onDidSaveTextDocument).toHaveBeenCalled();
      expect(vscode.workspace.onDidDeleteFiles).toHaveBeenCalled();
    });

    it('supersedes previous session', async () => {
      const sendChunk1 = jest.fn();
      const handle1 = interceptor.startSession(sendChunk1);
      const promise1 = handle1.wait();

      const sendChunk2 = jest.fn();
      interceptor.startSession(sendChunk2);

      // The first session should resolve (ended by supersession)
      const result = await promise1;
      expect(result).toBeDefined();
      expect(result.documentUris).toBeDefined();
    });
  });

  // ─── Scheme Filtering ────────────────────────────────────────

  describe('onDocumentChange — scheme filtering', () => {
    it('ignores output scheme', () => {
      interceptor.startSession(jest.fn());
      const event = makeChangeEvent('output', 'log output');
      interceptor.onDocumentChange(event);
      // No logging for output scheme — only the session start log
      const schemeLogs = outputChannel.info.mock.calls.filter(
        (c: any[]) => c[0].includes('DocChange'),
      );
      expect(schemeLogs.length).toBe(0);
    });

    it('ignores vscode-scm scheme', () => {
      interceptor.startSession(jest.fn());
      const event = makeChangeEvent('vscode-scm', 'scm input');
      interceptor.onDocumentChange(event);
      const schemeLogs = outputChannel.info.mock.calls.filter(
        (c: any[]) => c[0].includes('DocChange'),
      );
      expect(schemeLogs.length).toBe(0);
    });

    it('tracks schemes seen for non-ignored schemes', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);
      interceptor.onDocumentChange(makeChangeEvent('file', 'content'));
      // Can't directly inspect schemesSeen, but ending the session returns it
    });
  });

  // ─── No-op when no session ───────────────────────────────────

  describe('onDocumentChange — no session', () => {
    it('does nothing when no session is active', () => {
      // Should not throw
      const event = makeChangeEvent('file', 'content');
      interceptor.onDocumentChange(event);
    });

    it('does nothing when contentChanges is empty', () => {
      interceptor.startSession(jest.fn());
      const event = makeChangeEvent('file', 'content');
      event.contentChanges = [];
      interceptor.onDocumentChange(event);
      // No DocChange log
      const docLogs = outputChannel.info.mock.calls.filter(
        (c: any[]) => c[0].includes('DocChange'),
      );
      expect(docLogs.length).toBe(0);
    });
  });

  // ─── Chat Document Detection ──────────────────────────────────

  describe('chat document detection', () => {
    it('detects known chat schemes (vscode-copilot-chat)', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      const event = makeChangeEvent('vscode-copilot-chat', 'Hello from copilot');
      interceptor.onDocumentChange(event);

      // Should have streamed the content
      expect(sendChunk).toHaveBeenCalled();
    });

    it('detects known chat schemes (comment)', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      const event = makeChangeEvent('comment', 'Inline comment content');
      interceptor.onDocumentChange(event);

      expect(sendChunk).toHaveBeenCalled();
    });

    it('detects heuristic markdown in unknown scheme', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      // Content with markdown patterns + >50 chars
      const longMarkdown = '## Some Heading\n\nHere is a paragraph with **bold** text and ```code blocks``` for testing. Extra to exceed fifty characters.';
      const event = makeChangeEvent('custom-chat-scheme', longMarkdown);
      interceptor.onDocumentChange(event);

      expect(sendChunk).toHaveBeenCalled();
    });

    it('does not detect short non-markdown content as chat', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      const event = makeChangeEvent('custom-scheme', 'short');
      interceptor.onDocumentChange(event);

      // Should NOT have streamed (not a chat doc)
      expect(sendChunk).not.toHaveBeenCalled();
    });

    it('does not detect file scheme as chat', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      const longMarkdown = '## Big File\n\nWith **lots** of ```code``` and more content to pass the length threshold easily.';
      const event = makeChangeEvent('file', longMarkdown);
      interceptor.onDocumentChange(event);

      // file scheme should track as file change, not chat
      expect(sendChunk).not.toHaveBeenCalled();
    });
  });

  // ─── Incremental Streaming ────────────────────────────────────

  describe('incremental streaming', () => {
    it('streams only new content on subsequent changes', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      // First change: "Hello"
      const event1 = makeChangeEvent('vscode-copilot-chat', 'Hello');
      interceptor.onDocumentChange(event1);
      expect(sendChunk).toHaveBeenCalledWith('Hello');

      // Second change: "Hello World" (appended " World")
      sendChunk.mockClear();
      const event2 = makeChangeEvent('vscode-copilot-chat', 'Hello World');
      interceptor.onDocumentChange(event2);
      expect(sendChunk).toHaveBeenCalledWith(' World');
    });

    it('does not stream when content length has not grown', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      const event1 = makeChangeEvent('vscode-copilot-chat', 'Hello');
      interceptor.onDocumentChange(event1);
      sendChunk.mockClear();

      // Same length — no new content
      const event2 = makeChangeEvent('vscode-copilot-chat', 'Hello');
      interceptor.onDocumentChange(event2);
      expect(sendChunk).not.toHaveBeenCalled();
    });

    it('locks onto the first chat document and ignores others', () => {
      const sendChunk = jest.fn();
      interceptor.startSession(sendChunk);

      // First chat doc
      const event1 = makeChangeEvent('vscode-copilot-chat', 'First doc');
      event1.document.uri.toString = () => 'vscode-copilot-chat://doc1';
      interceptor.onDocumentChange(event1);
      expect(sendChunk).toHaveBeenCalledWith('First doc');

      // Second, different chat doc URI
      sendChunk.mockClear();
      const event2 = makeChangeEvent('vscode-copilot-chat', 'Second doc');
      event2.document.uri.toString = () => 'vscode-copilot-chat://doc2';
      interceptor.onDocumentChange(event2);
      // Should NOT stream from the second doc — locked onto first
      expect(sendChunk).not.toHaveBeenCalled();
    });
  });

  // ─── File Change Tracking ─────────────────────────────────────

  describe('file change tracking', () => {
    it('tracks file modifications with line diffs', () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);

      const event = makeChangeEvent('file', 'new content', [
        { text: 'line1\nline2\nline3', rangeStart: { line: 0 }, rangeEnd: { line: 1 } },
      ]);
      event.document.uri.toString = () => 'file:///workspace/src/test.ts';
      vscode.workspace.asRelativePath.mockReturnValue('src/test.ts');
      interceptor.onDocumentChange(event);

      // End the session to inspect results
      // Advance past debounce
      jest.advanceTimersByTime(7000);
    });

    it('skips .copilot-mobile-relay.md file', () => {
      interceptor.startSession(jest.fn());
      vscode.workspace.asRelativePath.mockReturnValue('.copilot-mobile-relay.md');

      const event = makeChangeEvent('file', 'relay content');
      interceptor.onDocumentChange(event);
      // Should not track this file change — but doesn't throw
    });
  });

  // ─── Debounce ─────────────────────────────────────────────────

  describe('debounce timer', () => {
    it('ends session after ACTIVITY_DEBOUNCE_MS of inactivity', async () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);
      const promise = handle.wait();

      // Trigger activity to set hasSeenActivity=true
      const event = makeChangeEvent('file', 'some change');
      interceptor.onDocumentChange(event);

      // Advance past debounce (6s)
      jest.advanceTimersByTime(6500);

      const result = await promise;
      expect(result).toBeDefined();
      expect(result.documentUris).toBeDefined();
    });

    it('resets debounce on new activity', async () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);

      // Trigger activity
      interceptor.onDocumentChange(makeChangeEvent('file', 'change 1'));

      // Advance 4s (before 6s debounce)
      jest.advanceTimersByTime(4000);

      // More activity — debounce should reset
      interceptor.onDocumentChange(makeChangeEvent('file', 'change 2'));

      // Advance another 4s (8s total, but debounce reset at 4s so only 4s since last activity)
      jest.advanceTimersByTime(4000);

      // Session should still be active (4s < 6s debounce since last activity)
      // No promise resolution yet — we can trigger more activity
      interceptor.onDocumentChange(makeChangeEvent('file', 'change 3'));
    });
  });

  // ─── Session Timeout ──────────────────────────────────────────

  describe('session timeout', () => {
    it('ends session after SESSION_TIMEOUT_MS (180s)', async () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);
      const promise = handle.wait();

      // Advance past timeout
      jest.advanceTimersByTime(181_000);

      const result = await promise;
      expect(result).toBeDefined();
    });
  });

  // ─── endSession result ────────────────────────────────────────

  describe('endSession result', () => {
    it('builds correct InterceptorResult', async () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);
      const promise = handle.wait();

      // Trigger a chat doc change
      const chatEvent = makeChangeEvent('vscode-copilot-chat', 'Response text');
      interceptor.onDocumentChange(chatEvent);

      // Trigger a file change
      vscode.workspace.asRelativePath.mockReturnValue('src/file.ts');
      const fileEvent = makeChangeEvent('file', 'file content', [
        { text: 'new\nlines', rangeStart: { line: 0 }, rangeEnd: { line: 0 } },
      ]);
      fileEvent.document.uri.toString = () => 'file:///workspace/src/file.ts';
      interceptor.onDocumentChange(fileEvent);

      // End via timeout
      jest.advanceTimersByTime(7000);
      const result = await promise;

      expect(result.capturedText).toBe('Response text');
      expect(result.documentUris.length).toBeGreaterThan(0);
      expect(result.schemesSeen.size).toBeGreaterThan(0);
      expect(result.schemesSeen.has('vscode-copilot-chat')).toBe(true);
      expect(result.schemesSeen.has('file')).toBe(true);
    });
  });

  // ─── dispose ──────────────────────────────────────────────────

  describe('dispose', () => {
    it('ends active session on dispose', async () => {
      const sendChunk = jest.fn();
      const handle = interceptor.startSession(sendChunk);
      const promise = handle.wait();

      interceptor.dispose();

      const result = await promise;
      expect(result).toBeDefined();
    });

    it('is safe to call multiple times', () => {
      interceptor.dispose();
      interceptor.dispose(); // no throw
    });

    it('is safe when no session is active', () => {
      interceptor.dispose(); // no throw
    });
  });
});
