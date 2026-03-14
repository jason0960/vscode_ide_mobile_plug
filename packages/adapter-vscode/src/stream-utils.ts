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
 * Latest-position wins: paragraph breaks (\n\n), code fence close (\n```\n),
 * and sentence-ending punctuation are all candidates; the rightmost one is used.
 */
export function findSafeBreak(text: string): number {
  if (text.length === 0) return 0;

  const FENCE = '\n```\n';
  const lastFenceClose = text.lastIndexOf(FENCE);
  const lastDoubleLF = text.lastIndexOf('\n\n');
  const lastSentenceEnd = Math.max(
    text.lastIndexOf('. '),
    text.lastIndexOf('.\n'),
    text.lastIndexOf('!\n'),
    text.lastIndexOf('?\n'),
    text.lastIndexOf(':\n'),
  );

  // Pick the rightmost candidate
  const breakIdx = Math.max(lastDoubleLF, lastFenceClose, lastSentenceEnd);

  if (breakIdx <= 0) return 0; // no safe break found — hold everything

  // Code fence close: include the full \n```\n sequence so mobile
  // receives the complete, closed code block.
  if (breakIdx === lastFenceClose && lastFenceClose >= 0) {
    return lastFenceClose + FENCE.length;
  }

  // Paragraph break: include both newlines
  if (text[breakIdx] === '\n' && breakIdx + 1 < text.length && text[breakIdx + 1] === '\n') {
    return breakIdx + 2;
  }
  if (text[breakIdx] === '\n') return breakIdx + 1;
  // For ". " or ".\n" etc, include the punctuation + whitespace
  return breakIdx + 2;
}
