import { extractGraph } from "../symbols/graph.js";
import { languageForPath } from "../chunker/languages.js";

/**
 * Lodestone-native "untested surface" detector — Tier-1 symbol-graph query
 * (see docs/LODESTONE_DESIGN.md §4 item 4: defs/refs/calls/imports back
 * "who calls X" / "is export Y unused" / import-map queries). Directly
 * saleable in an audit: "these N exported functions/classes have no test
 * touching them." Zero LLM calls, pure graph query.
 *
 * Model: reuses extractGraph() (symbols/graph.ts) per file, the same
 * read-only-reuse pattern deadCode.ts/singleUseHelper.ts/
 * singleImplementation.ts already establish for this module directory —
 * NOT a raw SQL query against CodeSearchDb's defs/refs/calls tables,
 * because db.ts exposes only single-symbol point lookups
 * (queryCallers/queryCallees/queryRefs/queryDefs/queryImports) and no bulk
 * "every def" / "every ref" read; extractGraph() over the same
 * `files: Array<{path, content}>` contract every sibling in this directory
 * takes produces the identical defs/refs data those bulk queries would
 * need, without adding a new CodeSearchDb method (out of this module's
 * scope). See dependencyCycles.ts and couplingOutliers.ts for the same
 * choice, made for the same reason.
 *
 * What "exported" means here, and why: this detector recognizes ONLY the
 * ESM `export` keyword — the def's own start line matched against
 * `/^\s*export\b/` (verified empirically: extractGraph()'s startLine for
 * `export function foo`, `export default function bar`,
 * `export abstract class Baz`, and `export const arrowFn = () => {}` all
 * point at the line the `export` keyword itself is on, not an unwrapped
 * inner node — see this module's test fixtures). It does NOT recognize:
 *   - CommonJS `exports.x = ...` / `module.exports.x = ...` property
 *     exports (no `export` keyword on that line) — under-reports (misses a
 *     real exported surface), never over-reports.
 *   - A separate `export { foo };` list naming a symbol declared without
 *     its own `export` prefix — same under-report direction.
 *   - Python: Python has no `export` keyword; the closest convention
 *     (leading-underscore-means-private) is a convention, not a
 *     declaration, and this ticket's acceptance evidence is real dogfood
 *     output on a TypeScript codebase — shipping an unverified
 *     convention-based path failed the "prefer not reporting when
 *     ambiguous" bar. Python files are simply not scanned by this
 *     detector; scope is typescript/tsx/javascript only (SCOPED_LANGUAGES
 *     below).
 * Exported "data" (a plain `export const CONFIG = {...}` with a
 * non-function value) never becomes a graph def in the first place —
 * verified empirically — so it cannot appear as a false-positive
 * "untested function" here.
 *
 * What a finding actually asserts — read this before trusting the output:
 * extractGraph()'s refs are a *global name-based xref* (see
 * symbols/graph.ts module doc) — not a resolved reference to *this* def. A
 * finding here means "no test file in the indexed set contains an
 * identifier occurrence of this exact name," which is weaker than "this
 * code path is uncovered" in two specific ways this module does NOT try to
 * paper over:
 *   1. Under-reports (falsely clears a genuinely untested symbol): if a
 *      test only exercises the export transitively (test calls A, A calls
 *      exported B, but B's name never appears in the test file itself), B
 *      is cleared even though no test names it directly. Also, if a test
 *      file happens to reference an unrelated identifier that shares this
 *      symbol's name (see name-collision note below), the real def is
 *      cleared by coincidence.
 *   2. Over-reports (falsely flags a symbol a test DOES exercise): only if
 *      the test never mentions the symbol by its own name at all (e.g. a
 *      dynamic `obj[methodName]()` call built from a string) — rare for
 *      the function/class-level surface this module scopes to.
 * Given the ticket's "precision over recall" bar, direction (1) is the
 * accepted trade-off — it can only make this detector under-claim (fewer
 * findings), never fabricate a covered symbol as untested.
 *
 * Name-based-resolution caveat (matches every sibling detector in this
 * directory): Lodestone does no path resolution — refs/calls are matched
 * by symbol name only. Two same-named exported functions in different
 * files share one combined "was this name mentioned in any test file"
 * verdict: if file A's `handle` is genuinely untested but file B's
 * unrelated `handle` IS tested, A's finding is silently suppressed (see
 * the "name collision" test in untestedSurface.test.ts, which asserts this
 * actual behavior rather than just describing it — the false negative is
 * real and demonstrated, not hypothetical). This is the same
 * under-report-only failure mode as (1) above, not a new risk.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeUntestedSurface()` resolves to an array of
 * `UntestedSurfaceFinding` records:
 *
 * ```json
 * [{ "symbol": "chargeCard", "path": "src/billing.ts", "line": 12,
 *    "kind": "function",
 *    "reason": "no test file references \"chargeCard\" by name anywhere in the indexed file set" }]
 * ```
 */

export interface UntestedSurfaceFinding {
  symbol: string;
  path: string;
  /** 1-based line the def (and its `export` keyword) starts on. */
  line: number;
  kind: "function" | "class";
  reason: string;
}

export interface UntestedSurfaceOptions {
  /** Predicate identifying test files — a name mentioned only inside a
   *  file this predicate matches does not count as "tested." Defaults to
   *  the same conventional test-path/suffix match deadCode.ts and
   *  singleUseHelper.ts use; override when a project uses a different
   *  convention (e.g. `*_spec.rb`, a `qa/` directory) that the default
   *  regex would miss — the point of taking this as an option rather than
   *  hardcoding one convention. */
  isTestFile?: (path: string) => boolean;
}

const DEFAULT_TEST_FILE_RE =
  /(^|[\\/])(tests?|__tests__|spec)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.py$/i;

/** Only container-level, individually-testable kinds. "method" is excluded
 *  for the same reason deadCode.ts excludes it: interface implementations,
 *  overrides, and dynamically-dispatched callbacks make single-method
 *  coverage attribution false-positive-prone. "interface" is excluded
 *  because an interface itself has no executable body to cover — its
 *  implementors (kind "class") are the testable surface. */
const SURFACE_KINDS: ReadonlySet<string> = new Set(["function", "class"]);

/** Languages with an unambiguous, single-line `export` keyword this
 *  module's line-prefix check can rely on — see module doc. */
const SCOPED_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
]);

const EXPORT_LINE_RE = /^\s*export\b/;

function reasonFor(symbol: string): string {
  return (
    `no test file references "${symbol}" by name anywhere in the indexed ` +
    `file set`
  );
}

/**
 * Find exported functions/classes with zero test-file references to their
 * name across `files`. Never throws — a file extractGraph() can't parse
 * simply contributes no defs/refs (see extractGraph's own fallback
 * contract).
 */
export async function computeUntestedSurface(
  files: Array<{ path: string; content: string }>,
  options?: UntestedSurfaceOptions,
): Promise<UntestedSurfaceFinding[]> {
  const isTestFile =
    options?.isTestFile ?? ((p) => DEFAULT_TEST_FILE_RE.test(p));

  const perFile = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      content: f.content,
      graph: await extractGraph(f.content, f.path),
    })),
  );

  // Every symbol name mentioned anywhere in a test file — refs already
  // include call-site identifiers (see symbols/graph.ts's global-xref
  // walk); calls is scanned too for parity with deadCode.ts's usedNames
  // convention.
  const testReferencedNames = new Set<string>();
  for (const { path, graph } of perFile) {
    if (!isTestFile(path)) continue;
    for (const r of graph.refs) testReferencedNames.add(r.symbol);
    for (const c of graph.calls) testReferencedNames.add(c.callee);
  }

  const findings: UntestedSurfaceFinding[] = [];
  for (const { path, content, graph } of perFile) {
    if (isTestFile(path)) continue;

    const langId = languageForPath(path);
    if (!langId || !SCOPED_LANGUAGES.has(langId)) continue;

    const lines = content.split("\n");

    for (const d of graph.defs) {
      if (!SURFACE_KINDS.has(d.kind)) continue;

      const lineText = lines[d.startLine - 1] ?? "";
      if (!EXPORT_LINE_RE.test(lineText)) continue;
      if (testReferencedNames.has(d.symbol)) continue;

      findings.push({
        symbol: d.symbol,
        path,
        line: d.startLine,
        kind: d.kind as "function" | "class",
        reason: reasonFor(d.symbol),
      });
    }
  }

  return findings;
}
