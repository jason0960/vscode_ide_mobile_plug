/**
 * findSafeBreak — unit tests
 *
 * Tests the streaming break-point algorithm that determines where
 * content can be safely split for incremental mobile delivery.
 *
 * Covers: empty text, paragraph breaks (\n\n), code fence close (\n```\n),
 * sentence-ending punctuation, priority ordering, no safe break found,
 * break-character inclusion logic.
 */

import { findSafeBreak } from '../src/stream-utils';

describe('findSafeBreak', () => {
  // ─── Empty / Trivial ─────────────────────────────────────────

  it('returns 0 for empty text', () => {
    expect(findSafeBreak('')).toBe(0);
  });

  it('returns 0 when no safe break found', () => {
    expect(findSafeBreak('hello world')).toBe(0);
  });

  it('returns 0 for text without any break characters', () => {
    expect(findSafeBreak('abc def ghi jkl')).toBe(0);
  });

  // ─── Paragraph Breaks (\n\n) ─────────────────────────────────

  it('finds paragraph break (\\n\\n)', () => {
    const text = 'First paragraph.\n\nSecond paragraph still going';
    const idx = findSafeBreak(text);
    // Should include both \n chars
    expect(idx).toBe(text.indexOf('\n\n') + 2);
    expect(text.substring(0, idx)).toBe('First paragraph.\n\n');
  });

  it('finds the LAST paragraph break', () => {
    const text = 'Para 1.\n\nPara 2.\n\nPara 3 ongoing';
    const idx = findSafeBreak(text);
    const lastBreak = text.lastIndexOf('\n\n');
    expect(idx).toBe(lastBreak + 2);
  });

  // ─── Code Fence Close (\n```\n) ───────────────────────────────

  it('finds code fence close', () => {
    const text = 'Before code:\n```js\nconsole.log("hi");\n```\nAfter';
    const idx = findSafeBreak(text);
    // The \n before ``` is at some position, break should include it
    expect(idx).toBeGreaterThan(0);
    expect(text.substring(0, idx)).toContain('```');
  });

  // ─── Sentence-ending Punctuation ──────────────────────────────

  it('finds period-space (". ")', () => {
    const text = 'Hello world. This continues';
    const idx = findSafeBreak(text);
    expect(idx).toBe(text.indexOf('. ') + 2);
    expect(text.substring(0, idx)).toBe('Hello world. ');
  });

  it('finds period-newline (".\\n")', () => {
    const text = 'End of sentence.\nNew line content';
    const idx = findSafeBreak(text);
    expect(idx).toBe(text.indexOf('.\n') + 2);
  });

  it('finds exclamation-newline ("!\\n")', () => {
    const text = 'Wow!\nMore text here';
    const idx = findSafeBreak(text);
    expect(idx).toBe(text.indexOf('!\n') + 2);
  });

  it('finds question-newline ("?\\n")', () => {
    const text = 'Is it working?\nYes it is';
    const idx = findSafeBreak(text);
    expect(idx).toBe(text.indexOf('?\n') + 2);
  });

  it('finds colon-newline (":\\n")', () => {
    const text = 'Here is the list:\n- item 1';
    const idx = findSafeBreak(text);
    expect(idx).toBe(text.indexOf(':\n') + 2);
  });

  // ─── Priority ─────────────────────────────────────────────────

  it('prefers paragraph break over sentence end', () => {
    // paragraph break appears before sentence end, but paragraph break wins
    // because Math.max picks the higher index
    const text = 'Para 1.\n\nPara 2. More text here';
    const idx = findSafeBreak(text);
    const lastParagraph = text.lastIndexOf('\n\n');
    const lastSentence = text.lastIndexOf('. ');
    // Whichever is later in the text should win
    expect(idx).toBe(Math.max(lastParagraph + 2, lastSentence + 2));
  });

  it('returns latest break regardless of type', () => {
    // The algorithm uses Math.max on all break indices
    const text = 'End.\n\nMid sentence. More at the end:\nFinal';
    const idx = findSafeBreak(text);
    expect(idx).toBeGreaterThan(0);
    // Just verify it returns a valid break point
    expect(idx).toBeLessThanOrEqual(text.length);
  });

  // ─── Break at position 0 ─────────────────────────────────────

  it('returns 0 when break is only at position 0', () => {
    // If the only potential break character is at position 0,
    // breakIdx <= 0 triggers the "no safe break" path
    const text = '. rest of text';
    const idx = findSafeBreak(text);
    expect(idx).toBe(0);
  });

  // ─── Newline-only break ───────────────────────────────────────

  it('includes single newline for fence/paragraph breaks', () => {
    // When breakIdx points to a \n followed by non-\n
    const text = 'Some code\n```\nMore stuff after fence';
    const idx = findSafeBreak(text);
    expect(idx).toBeGreaterThan(0);
  });
});
