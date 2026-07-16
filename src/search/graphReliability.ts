import { languageForPath } from "../chunker/languages.js";

/**
 * Languages for which src/symbols/graph.ts's tree-sitter tier produces a
 * verified, whole-file *global* (cross-file) name-based refs/calls xref —
 * see graph.ts's `CALL_NODE` table and its module doc (W3-04). Every other
 * extension — the 8 tree-sitter-defs-only grammars (go, rust, java,
 * c_sharp, ruby, php, c, cpp) and every grammarless language (swift, kt,
 * md, ...) — falls through to graph.ts's regex tier for refs/calls, whose
 * refs are SAME-FILE-ONLY: a def in file A used only from file B will show
 * zero refs/callers there even though it's live.
 *
 * `extractGraph()`'s per-file `method` tag ("tree-sitter" | "regex") is
 * never persisted to the schema — the defs/refs/calls tables carry no tier
 * column (see db.ts SCHEMA) — so this constant is the only place that
 * distinction survives past indexing. Keep it in sync with graph.ts's
 * `CALL_NODE` keys if that table changes.
 */
const RELIABLE_CROSS_FILE_LANGS = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

/**
 * True when `filePath`'s language has a verified cross-file refs/calls
 * xref. False (low confidence) for the 8 defs-only grammars and every
 * grammarless language — an empty queryCallers()/queryRefs() result for a
 * symbol defined in such a file is evidence of "no same-file usage", NOT
 * evidence the symbol is unused/dead across the repo.
 *
 * Note this rates only the *def's own* file. A caller edge recorded from a
 * regex-tier caller file is itself only a same-file-derived edge, so "N
 * callers, all themselves in reliable-language files" is stronger evidence
 * than a raw count — this function returns a single top-level confidence
 * flag for the def's file, not a per-edge filter over the caller list.
 */
export function isCrossFileGraphReliable(filePath: string): boolean {
  const lang = languageForPath(filePath);
  return !!lang && RELIABLE_CROSS_FILE_LANGS.has(lang);
}
