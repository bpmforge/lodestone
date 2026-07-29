import { extractGraph } from "../symbols/graph.js";
import { buildResolvedImportGraph } from "./dependencyCycles.js";

/**
 * Lodestone-native coupling-outlier detector — Tier-1 symbol-graph query
 * over the `calls` and `imports` edges (see docs/LODESTONE_DESIGN.md §4
 * item 4). Fan-in/fan-out per symbol and per file, reported by
 * distribution (top percentile) rather than a hardcoded magic threshold —
 * "more than 10 callers is bad" is arbitrary across codebases of different
 * size and shape; "top 5% of this codebase's own call/import graph" is
 * not. Zero LLM calls.
 *
 * Model: reuses extractGraph() per file (calls) and dependencyCycles.ts's
 * buildResolvedImportGraph() (imports, already-resolved to real file paths
 * in the given set) — the same `files: Array<{path, content}>` contract
 * every sibling detector in this directory takes, not a raw SQL query
 * against CodeSearchDb, for the same reason untestedSurface.ts and
 * dependencyCycles.ts document: db.ts has no bulk "every call" / "every
 * import" read, only single-symbol/single-file point lookups.
 *
 * Four independent distributions, one shared percentile-outlier rule:
 *   - symbol fan-in:  distinct calling symbols for a given callee name.
 *   - symbol fan-out: distinct callee names a given symbol itself calls.
 *   - file fan-in:    distinct files that resolve-import a given file.
 *   - file fan-out:   distinct files a given file resolve-imports.
 * A self-call/self-import (recursion, a barrel re-exporting itself) is
 * excluded from both sides of its own count — recursion is not coupling
 * in the sense this detector cares about.
 *
 * Symbol scope: only `kind: "function"` and `kind: "method"` defs are
 * counted as symbol nodes. `class`/`interface` defs are deliberately
 * excluded — graph.ts's CALL_NODE only recognizes `call_expression`
 * (`foo()`), not a constructor call (`new Widget()`, a different grammar
 * node type entirely, see symbols/graph.ts's CALL_NODE map) — so a class's
 * real "fan-in" via construction is invisible to the `calls` table this
 * detector reads, and reporting a near-always-zero count for every class
 * would be noise, not signal.
 *
 * Built-in/library call filter (found by dogfooding, not designed up
 * front — see the ticket's dogfood-catches-design-errors requirement): a
 * `calls` row records ANY call-shaped syntax, `caller`/`callee` are bare
 * names with no receiver-type information (symbols/graph.ts's MEMBER_NODE
 * resolves `obj.map(...)` down to the property name `map`, same as any
 * other callee). Without a filter, this detector's symbol distributions
 * are dominated by Array/Map/String-prototype method names
 * (`map`/`get`/`has`/`push`/`filter`/`split`/...) and by `<module>`
 * (graph.ts's synthetic placeholder for top-level-of-file calls, not a
 * real symbol) — none of which is "coupling" in any actionable sense, and
 * running this module against lodestone's own source before this filter
 * existed put `map`/`push`/`<module>` at the very top of both
 * distributions, ahead of every real project symbol. The fix: a
 * caller/callee name only enters the symbol-level fan-in/fan-out count
 * when it has at least one matching entry in `definedIn` — i.e. some
 * `function`/`method` def in the analyzed file set actually carries that
 * name. This is a strict narrowing (under-reports, never fabricates): a
 * genuine call to a project function whose def wasn't included in `files`
 * (partial file sets, e.g. auditing one package of a monorepo) is
 * silently dropped from both sides, same direction as every other
 * limitation in this module.
 *
 * Percentile method: for each distribution, the population is every
 * symbol/file with a non-zero count (a count of 0 is not part of a "how
 * coupled is this" conversation — that is dead-code/untested-surface
 * territory, already covered by sibling detectors). An entity's percentile
 * rank is the fraction of the population strictly below its count
 * (`countStrictlyLessThan / N`); it is reported when that rank is >=
 * `options.percentile` (default 0.95 — top 5%). Ties: every entity sharing
 * the maximum count gets the same rank, so a distribution dominated by
 * ties at the top reports all of them, not an arbitrary N — see
 * couplingOutliers.test.ts's tie test, which asserts this does NOT
 * flood the output when most of the codebase legitimately shares one
 * value.
 *
 * `minSampleSize` (default 20): below this population size, percentile
 * rank is statistically meaningless (a "95th percentile" of 4 items is
 * either the max item or nothing) — the distribution is skipped entirely
 * (contributes zero findings) rather than reporting a spurious outlier.
 * This is a validity guard on the statistic, not a magic badness
 * threshold on coupling itself — the actual outlier cutoff stays
 * percentile-based, per the ticket's requirement.
 *
 * Name-based-resolution caveat: symbol-level fan-in/fan-out is
 * name-based, same as every calls/refs-driven detector in this directory
 * — two unrelated same-named functions in different files have their call
 * counts summed into one figure. Each symbol finding lists every file with
 * a matching def (`definedIn`) so this conflation is visible in the
 * finding itself rather than hidden behind one arbitrarily-chosen path.
 * File-level fan-in/fan-out is path-based (dependencyCycles.ts's resolved
 * import graph), not subject to this conflation.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeCouplingOutliers()` resolves to an array of
 * `CouplingOutlierFinding` records:
 *
 * ```json
 * [{ "scope": "symbol", "direction": "fan-in", "name": "validate",
 *    "definedIn": ["src/validate.ts"], "count": 41, "percentile": 0.98,
 *    "thresholdPercentile": 0.95, "sampleSize": 120, "reason": "..." }]
 * ```
 */

export interface CouplingOutlierFinding {
  scope: "symbol" | "file";
  direction: "fan-in" | "fan-out";
  /** Symbol name (scope "symbol") or file path (scope "file"). */
  name: string;
  /** scope "symbol" only: every file with a def of this name — see the
   *  name-based-resolution caveat above. Omitted for scope "file". */
  definedIn?: string[];
  count: number;
  /** This entity's percentile rank within its own distribution (0-1). */
  percentile: number;
  /** The cutoff that qualified this entity as an outlier. */
  thresholdPercentile: number;
  /** Population size of the distribution this entity was ranked in. */
  sampleSize: number;
  reason: string;
}

export interface CouplingOutlierOptions {
  /** Percentile cutoff (0-1) an entity's count must meet or exceed to be
   *  reported. Default 0.95 (top 5%). */
  percentile?: number;
  /** Minimum population size before a distribution's percentile ranking is
   *  considered statistically meaningful. Below this, that distribution
   *  contributes no findings. Default 20. */
  minSampleSize?: number;
}

const DEFAULT_PERCENTILE = 0.95;
const DEFAULT_MIN_SAMPLE_SIZE = 20;

const SYMBOL_KINDS: ReadonlySet<string> = new Set(["function", "method"]);

interface RankedEntity {
  name: string;
  count: number;
}

/** Percentile-rank `entities` and return those at/above `percentile`,
 *  sorted by count descending. Returns [] if `entities.length` is below
 *  `minSampleSize` — see module doc. */
function selectOutliers(
  entities: RankedEntity[],
  percentile: number,
  minSampleSize: number,
): Array<RankedEntity & { percentile: number; sampleSize: number }> {
  const n = entities.length;
  if (n < minSampleSize) return [];

  const counts = entities.map((e) => e.count).sort((a, b) => a - b);
  function rankOf(count: number): number {
    // First index whose count is >= `count` = number of entities strictly
    // below it (counts is sorted ascending).
    let lo = 0;
    let hi = counts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (counts[mid] < count) lo = mid + 1;
      else hi = mid;
    }
    return lo / n;
  }

  const out: Array<RankedEntity & { percentile: number; sampleSize: number }> =
    [];
  for (const e of entities) {
    const rank = rankOf(e.count);
    if (rank >= percentile) {
      out.push({ ...e, percentile: rank, sampleSize: n });
    }
  }
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

function reasonFor(
  scope: "symbol" | "file",
  direction: "fan-in" | "fan-out",
  count: number,
  percentile: number,
): string {
  const what =
    scope === "symbol"
      ? direction === "fan-in"
        ? "distinct calling symbols"
        : "distinct symbols it calls"
      : direction === "fan-in"
        ? "distinct files that import it"
        : "distinct files it imports";
  return (
    `${count} ${what} — ${(percentile * 100).toFixed(1)}th percentile of ` +
    `this codebase's own ${scope} ${direction} distribution (not a fixed ` +
    `threshold)`
  );
}

/**
 * Find fan-in/fan-out coupling outliers, per symbol and per file, across
 * `files`. Never throws — a file extractGraph() can't parse simply
 * contributes no calls/imports.
 */
export async function computeCouplingOutliers(
  files: Array<{ path: string; content: string }>,
  options?: CouplingOutlierOptions,
): Promise<CouplingOutlierFinding[]> {
  const percentile = options?.percentile ?? DEFAULT_PERCENTILE;
  const minSampleSize = options?.minSampleSize ?? DEFAULT_MIN_SAMPLE_SIZE;

  const perFile = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      graph: await extractGraph(f.content, f.path),
    })),
  );

  // --- symbol-level: definedIn map + fan-in/fan-out call sets ------------
  const definedIn = new Map<string, Set<string>>();
  for (const { path, graph } of perFile) {
    for (const d of graph.defs) {
      if (!SYMBOL_KINDS.has(d.kind)) continue;
      let set = definedIn.get(d.symbol);
      if (!set) {
        set = new Set();
        definedIn.set(d.symbol, set);
      }
      set.add(path);
    }
  }

  // Only edges where BOTH ends are themselves project-defined symbols
  // count toward coupling — see module doc's "built-in/library call
  // filter". Without this, `.map()`/`.get()`/`.filter()`-style calls to
  // Array/Map/String prototype methods (or any callee that happens to
  // share a name with no def in the analyzed set) dominate the fan-in
  // distribution: verified empirically dogfooding this module against
  // lodestone itself before this filter existed — "map"/"push"/"has"/
  // "get" outranked every real project symbol, and `<module>` (graph.ts's
  // synthetic top-level-caller placeholder, not a real symbol at all) hit
  // the single highest fan-out count in the repo. Both are noise this
  // filter removes at the source rather than downstream.
  const callers = new Map<string, Set<string>>(); // callee -> callers
  const callees = new Map<string, Set<string>>(); // caller -> callees
  for (const { graph } of perFile) {
    for (const c of graph.calls) {
      if (c.caller === c.callee) continue; // exclude self-recursion
      if (!definedIn.has(c.caller) || !definedIn.has(c.callee)) continue;

      let inSet = callers.get(c.callee);
      if (!inSet) {
        inSet = new Set();
        callers.set(c.callee, inSet);
      }
      inSet.add(c.caller);

      let outSet = callees.get(c.caller);
      if (!outSet) {
        outSet = new Set();
        callees.set(c.caller, outSet);
      }
      outSet.add(c.callee);
    }
  }

  // --- file-level: resolved import graph ----------------------------------
  const importGraph = await buildResolvedImportGraph(files);
  const fileFanIn = new Map<string, Set<string>>(); // target -> importers
  for (const [from, targets] of importGraph) {
    for (const to of targets) {
      if (to === from) continue; // exclude self-import
      let set = fileFanIn.get(to);
      if (!set) {
        set = new Set();
        fileFanIn.set(to, set);
      }
      set.add(from);
    }
  }

  const findings: CouplingOutlierFinding[] = [];

  function pushSymbolFindings(
    map: Map<string, Set<string>>,
    direction: "fan-in" | "fan-out",
  ): void {
    const entities: RankedEntity[] = [...map.entries()].map(([name, set]) => ({
      name,
      count: set.size,
    }));
    for (const r of selectOutliers(entities, percentile, minSampleSize)) {
      findings.push({
        scope: "symbol",
        direction,
        name: r.name,
        definedIn: [...(definedIn.get(r.name) ?? [])].sort(),
        count: r.count,
        percentile: r.percentile,
        thresholdPercentile: percentile,
        sampleSize: r.sampleSize,
        reason: reasonFor("symbol", direction, r.count, r.percentile),
      });
    }
  }

  function pushFileFindings(
    map: Map<string, Set<string>>,
    direction: "fan-in" | "fan-out",
  ): void {
    const entities: RankedEntity[] = [...map.entries()].map(([name, set]) => ({
      name,
      count: set.size,
    }));
    for (const r of selectOutliers(entities, percentile, minSampleSize)) {
      findings.push({
        scope: "file",
        direction,
        name: r.name,
        count: r.count,
        percentile: r.percentile,
        thresholdPercentile: percentile,
        sampleSize: r.sampleSize,
        reason: reasonFor("file", direction, r.count, r.percentile),
      });
    }
  }

  pushSymbolFindings(callers, "fan-in");
  pushSymbolFindings(callees, "fan-out");
  const fileFanOut = new Map(
    [...importGraph.entries()].map(([from, targets]) => [
      from,
      new Set([...targets].filter((t) => t !== from)),
    ]),
  );
  pushFileFindings(fileFanIn, "fan-in");
  pushFileFindings(fileFanOut, "fan-out");

  return findings;
}
