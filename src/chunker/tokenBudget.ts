/**
 * Rough token-count heuristic used to keep AST chunks inside a target budget
 * without pulling in a real tokenizer (tiktoken etc.) as a dependency.
 *
 * ~4 characters/token is a standard conservative approximation for source
 * code (shorter identifiers/punctuation skew it slightly, but it's stable
 * enough to size chunks — exactness isn't the goal, staying in-band is).
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Target chunk size. cAST (EMNLP 2025) recommends ~1000-1500 tokens. */
export const CHUNK_TOKEN_BUDGET = 1200;
