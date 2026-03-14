/**
 * Streaming text-break utilities.
 *
 * Pure functions for finding safe break points in streamed markdown/code
 * content, so we never send half-finished thoughts to mobile.
 */

/**
 * Find the last "safe" break point — end of a complete sentence, paragraph,
 * or code block — so we never stream a half-finished thought to mobile.
 * Returns the index (exclusive) up to which the content is safe to send.
 *
 * Priority: paragraph breaks (\n\n) > code fence close (\n```\n) > sentence-ending punctuation
 */
export function findSafeBreak(text: string): number {
  if (text.length === 0) return 0;

  // If the text ends with a code fence close, it's a complete block
  const lastFenceClose = text.lastIndexOf('\n```\n');
  const lastDoubleLF = text.lastIndexOf('\n\n');
  const lastSentenceEnd = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('?\n'),
    text.lastIndexOf(':\n'),
  );
  // Prefer paragraph breaks > code fence close > sentence-ending punctuation
  const breakIdx = Math.max(lastDoubleLF, lastFenceClose, lastSentenceEnd);

  if (breakIdx <= 0) return 0; // no safe break found — hold everything

  // Include the break character(s) themselves
  if (text[breakIdx] === '\n' && breakIdx + 1 < text.length && text[breakIdx + 1] === '\n') {
    return breakIdx + 2;
  }
  if (text[breakIdx] === '\n') return breakIdx + 1;
  // For ". " or ".\n" etc, include the punctuation + whitespace
  return breakIdx + 2;
}
