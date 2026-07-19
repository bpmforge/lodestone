import { extractGraph } from "../symbols/graph.js";

/**
 * Lodestone-native ANTI_SLOP R-07 detector — "single-use helper functions"
 * (see ~/Code/bpm-opencode-experts/agents/shared/ANTI_SLOP_RULES.md,
 * Category 2 "Abstraction Slop"). Exact rule text:
 *
 *   Pattern: Extracting 2-4 lines into a named function called exactly
 *   once in the codebase.
 *   Rule: Extract to a function only when it is called >= 2 times OR it
 *   represents a named domain concept worth making explicit. One call =
 *   inline it.
 *
 * This is a symbol-graph detector, not a rulepack rule: "called exactly
 * once" needs a project-wide call count, which a single-file grep/AST rule
 * cannot see (bpm-rulepacks W1-06 close note flagged R-07 as exactly this
 * kind of deferred-to-symbol-graph rule). It queries `extractGraph()`
 * (symbols/graph.ts, read-only reuse — no new parser) for function defs
 * and call sites, and counts, per symbol name, how many call sites exist
 * across the whole indexed file set.
 *
 * Only `kind: "function"` defs are considered — same exclusion deadCode.ts
 * makes for "method": interface implementations, overrides, and
 * dynamically-dispatched callbacks make a single-call-site method a
 * false-positive-prone signal (a method IS its interface contract, not an
 * extractable helper) regardless of language tier.
 *
 * A def whose call count is 0 is dead code, not a single-use helper — that
 * case is already reported by computeDeadCode(); this module only reports
 * the "called exactly once" case, so the two detectors' outputs don't
 * overlap.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeSingleUseHelper()` resolves to an array of
 * `SingleUseHelperFinding` records:
 *
 * ```json
 * [{ "rule": "R-07", "symbol": "formatUserLabel", "path": "src/x.ts",
 *    "line": 12, "callSite": { "path": "src/y.ts", "line": 40 },
 *    "reason": "..." }]
 * ```
 */

export interface SingleUseHelperFinding {
  rule: "R-07";
  symbol: string;
  path: string;
  /** 1-based line the def starts on. */
  line: number;
  /** The one call site found across the indexed file set. */
  callSite: { path: string; line: number };
  reason: string;
}

export interface SingleUseHelperOptions {
  /** Predicate identifying test files. A helper whose only call site is in
   *  a test file is still "called exactly once" and gets flagged — tests
   *  are not excluded from the count, only from being scanned as a source
   *  of *defs* (a test-only helper called once by that same test is a test
   *  concern, not production abstraction slop). Defaults to the same
   *  conventional test-path/suffix match deadCode.ts uses. */
  isTestFile?: (path: string) => boolean;
}

const DEFAULT_TEST_FILE_RE =
  /(^|[\\/])(tests?|__tests__|spec)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]*\.py$|_test\.py$/i;

const REASON =
  "R-07 single-use helper: called exactly once across the indexed file " +
  "set — extract to a function only when it is called >= 2 times or it " +
  "names a domain concept worth making explicit (ANTI_SLOP_RULES.md " +
  "R-07); a single call site should be inlined.";

/**
 * Find function defs called from exactly one call site across `files`.
 * Never throws — a file extractGraph() can't parse simply contributes no
 * defs/calls (see extractGraph's own fallback contract).
 */
export async function computeSingleUseHelper(
  files: Array<{ path: string; content: string }>,
  options?: SingleUseHelperOptions,
): Promise<SingleUseHelperFinding[]> {
  const isTestFile =
    options?.isTestFile ?? ((p) => DEFAULT_TEST_FILE_RE.test(p));

  const perFile = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      graph: await extractGraph(f.content, f.path),
    })),
  );

  // Every call site for a given callee name, across the whole file set —
  // global (not per-language) by design, matching deadCode.ts's usedNames
  // convention: a name-based count, not an LSP-grade binder (see
  // symbols/graph.ts module doc).
  const callSitesByName = new Map<string, { path: string; line: number }[]>();
  for (const { path, graph } of perFile) {
    for (const c of graph.calls) {
      let sites = callSitesByName.get(c.callee);
      if (!sites) {
        sites = [];
        callSitesByName.set(c.callee, sites);
      }
      sites.push({ path, line: c.line });
    }
  }

  const findings: SingleUseHelperFinding[] = [];
  for (const { path, graph } of perFile) {
    if (isTestFile(path)) continue;

    for (const d of graph.defs) {
      if (d.kind !== "function") continue;

      const sites = callSitesByName.get(d.symbol);
      if (!sites || sites.length !== 1) continue;

      findings.push({
        rule: "R-07",
        symbol: d.symbol,
        path,
        line: d.startLine,
        callSite: sites[0],
        reason: REASON,
      });
    }
  }

  return findings;
}
