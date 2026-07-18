import { extractGraph } from "../symbols/graph.js";
import { languageForPath } from "../chunker/languages.js";

/**
 * Lodestone-native dead-code metric — the in-house replacement for
 * `knip`-class tools (see docs/LODESTONE_DESIGN.md §7 "in-house ladder").
 * Queries the symbol graph (symbols/graph.ts, read-only reuse — no new
 * parser) for defined functions/classes with zero non-test references or
 * calls anywhere across the file set handed in.
 *
 * CRITICAL tier-awareness (carried forward from the W3-04 ticket close, see
 * symbols/graph.ts's "refs fidelity note"): `extractGraph()` produces
 * fully cross-file-capable refs only for the tree-sitter-verified
 * languages — typescript/tsx/javascript/python (the same set graph.ts's
 * CALL_NODE covers). For every other language (go, rust, java, c_sharp,
 * ruby, php, c, cpp — tree-sitter defs but regex-tier refs — and any
 * grammarless extension, regex-tier defs *and* refs), `refs` only records
 * occurrences of names *that same file itself defines*; a genuine cross-
 * file usage of one of those symbols is invisible to that file's own scan
 * and would otherwise look falsely unused. (The regex tier's `calls` list
 * is not similarly restricted — it records any `identifier(` call-site
 * regardless of origin file — so cross-file *calls* are still caught for
 * those languages; only a non-call reference, e.g. passing a function by
 * name without invoking it, can slip through.) Because that gap is real,
 * this module NEVER reports a low-tier finding as high-confidence: only
 * defs from the four cross-file-capable languages get `confidence:
 * "high"`; everything else is `"low"` — reported, not hidden, but flagged
 * as needing a human/LLM second look before acting on it.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeDeadCode()` resolves to an array of
 * `DeadCodeFinding` records:
 *
 * ```json
 * [{ "symbol": "unusedHelper", "path": "src/util.ts", "line": 12,
 *    "kind": "function", "confidence": "high",
 *    "reason": "no references or calls found in the indexed file set" }]
 * ```
 */

export interface DeadCodeFinding {
  symbol: string;
  path: string;
  /** 1-based line the definition starts on. */
  line: number;
  kind: string;
  /** "high" only for the four cross-file-capable languages (ts/tsx/js/py)
   *  — see module doc. "low" means the negative result (no refs found)
   *  cannot be fully trusted because refs for this file's language are
   *  same-file-only. */
  confidence: "high" | "low";
  reason: string;
}

export interface DeadCodeOptions {
  /** Predicate identifying test files, whose refs/calls don't count toward
   *  "used" (a symbol referenced only by its own test is still dead
   *  production code). Defaults to a conventional test-path/suffix match. */
  isTestFile?: (path: string) => boolean;
}

const DEFAULT_TEST_FILE_RE =
  /(^|[\\/])(tests?|__tests__|spec)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.py$/i;

/** Languages where extractGraph()'s refs are a global, cross-file-capable
 *  name-based xref (graph.ts's CALL_NODE keys — verified live against the
 *  grammar for these four only, see graph.test.ts). */
const CROSS_FILE_REFS_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

/** Kinds this module flags. "method" is deliberately excluded: interface
 *  implementations, overrides, and dynamically-dispatched callbacks make
 *  unused-method detection false-positive-prone regardless of language
 *  tier — the same reason most dead-code tools gate it behind an opt-in. */
const DEAD_CODE_KINDS: ReadonlySet<string> = new Set(["function", "class"]);

function confidenceFor(path: string): DeadCodeFinding["confidence"] {
  const langId = languageForPath(path);
  return langId && CROSS_FILE_REFS_LANGUAGES.has(langId) ? "high" : "low";
}

function reasonFor(confidence: DeadCodeFinding["confidence"]): string {
  return confidence === "high"
    ? "no references or calls found in the indexed file set (this language's refs are cross-file-capable)"
    : "no references or calls found in the indexed file set, but this language's refs are same-file-only — a cross-file usage may not be visible; verify before removing";
}

/**
 * Find defined functions/classes with zero non-test references or calls
 * across `files`. Never throws — a file extractGraph() can't parse simply
 * contributes no defs/refs (see extractGraph's own fallback contract).
 */
export async function computeDeadCode(
  files: Array<{ path: string; content: string }>,
  options?: DeadCodeOptions,
): Promise<DeadCodeFinding[]> {
  const isTestFile =
    options?.isTestFile ?? ((p) => DEFAULT_TEST_FILE_RE.test(p));

  const perFile = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      graph: await extractGraph(f.content, f.path),
    })),
  );

  // Union of every symbol name referenced or called from a non-test file.
  // Global (not per-language) by design: a cross-file-capable file's scan
  // of a shared name is enough to clear a def anywhere with that name.
  const usedNames = new Set<string>();
  for (const { path, graph } of perFile) {
    if (isTestFile(path)) continue;
    for (const r of graph.refs) usedNames.add(r.symbol);
    for (const c of graph.calls) usedNames.add(c.callee);
  }

  const findings: DeadCodeFinding[] = [];
  for (const { path, graph } of perFile) {
    for (const d of graph.defs) {
      if (!DEAD_CODE_KINDS.has(d.kind)) continue;
      if (usedNames.has(d.symbol)) continue;

      const confidence = confidenceFor(path);
      findings.push({
        symbol: d.symbol,
        path,
        line: d.startLine,
        kind: d.kind,
        confidence,
        reason: reasonFor(confidence),
      });
    }
  }

  return findings;
}
