import type { Chunk } from "./types.js";

const CHUNK_LINES = 60;
const OVERLAP_LINES = 15;
const MIN_CHUNK_CHARS = 50;

/**
 * Sliding-window line chunker. This is the original chunking strategy
 * (v0.1-0.4) and is now the fallback path for:
 *   - files with no filePath (language unknown)
 *   - files whose extension has no tree-sitter grammar wired up
 *   - any file where the AST parse/walk throws for any reason
 *
 * Never touch this without checking src/tests/chunker.test.ts — its exact
 * behavior (line numbers, overlap, min-length filtering) is load-bearing
 * for the fallback guarantee: coverage must stay total even when AST
 * chunking isn't available.
 */
export function windowChunk(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];

  let i = 0;
  while (i < lines.length) {
    const start = i;
    const end = Math.min(i + CHUNK_LINES - 1, lines.length - 1);
    const text = lines
      .slice(start, end + 1)
      .join("\n")
      .trim();

    if (text.length >= MIN_CHUNK_CHARS) {
      chunks.push({ text, startLine: start + 1, endLine: end + 1 });
    }

    i += CHUNK_LINES - OVERLAP_LINES;
  }

  return chunks;
}
