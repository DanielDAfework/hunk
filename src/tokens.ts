/**
 * Token estimation. A deliberate heuristic: ~4 characters per token, which is
 * a decent fit for shell output on BPE tokenizers. All budgets in the tool
 * surface use this same estimator so comparisons stay apples-to-apples.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Estimate tokens for an array of lines, counting the joining newlines. */
export function estimateTokensLines(lines: string[]): number {
  let chars = 0;
  for (const l of lines) chars += l.length + 1;
  return chars === 0 ? 0 : Math.ceil(chars / 4);
}
