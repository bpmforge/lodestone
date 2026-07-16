import type { CodeSearchDb } from "../db.js";

export interface RangeSymbol {
  name: string;
  kind: string;
  line: number;
}

/**
 * Symbols the index recorded as declared inside [startLine, endLine] of
 * `filePath` — the same correlation indexer.ts uses to populate a chunk's
 * FTS5 symbols/subtokens columns (see indexer.ts's insertChunks call: each
 * chunk's `symbols` field is `symbols.filter(s => s.line in [chunk range])`).
 * Used here to find "this chunk's own symbols" for definition detection,
 * centrality scoring, and call-graph neighbor lookups.
 *
 * There is no chunk-by-path/range query on CodeSearchDb (see db.ts) —
 * `querySymbols({ pathFilter })` is a substring `LIKE`, so `filePath` is
 * passed as the filter and results are re-filtered here to an *exact* path
 * match plus the line range.
 */
export function symbolsInRange(
  db: CodeSearchDb,
  filePath: string,
  startLine: number,
  endLine: number,
): RangeSymbol[] {
  return db
    .querySymbols({ pathFilter: filePath, limit: 1000 })
    .filter(
      (s) =>
        s.filePath === filePath && s.line >= startLine && s.line <= endLine,
    )
    .map((s) => ({ name: s.name, kind: s.kind, line: s.line }));
}
