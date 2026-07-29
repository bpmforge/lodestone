import path from "path";
import { extractGraph } from "../symbols/graph.js";

/**
 * Lodestone-native dependency-cycle detector — Tier-1 symbol-graph query
 * over the `imports` edge (see docs/LODESTONE_DESIGN.md §4 item 4).
 * Strongly-connected components (Tarjan's algorithm) over the resolved
 * import graph, reported as concrete `a -> b -> c -> a` chains, not a
 * boolean. Zero LLM calls.
 *
 * Model: reuses extractGraph() (symbols/graph.ts) per file — the same
 * `files: Array<{path, content}>` input contract every sibling detector in
 * this directory takes — rather than a raw SQL query against
 * CodeSearchDb's `imports` table, for the same reason untestedSurface.ts
 * documents: db.ts exposes only `queryImports(fromPath)` (single-file
 * point lookup, see db.ts), no bulk "every import edge" read, and adding
 * one is a db.ts change outside this module's scope. extractGraph() over
 * the same file set produces the identical `imports` rows that table
 * holds.
 *
 * File-level, not module/symbol-level: Lodestone's `imports` table (and
 * `ImportRow`) records file -> module-specifier edges, one row per import
 * statement, not per imported binding — there is no "symbol X in file A
 * depends on symbol Y in file B" edge to build a finer graph from. This
 * module treats each file as one graph node.
 *
 * Import resolution (the load-bearing, otherwise-undocumented part): a
 * `toPathOrModule` value is a raw specifier straight off the import
 * statement (verified empirically against this repo's own source: an
 * internal import prints as `"../symbols/graph.js"` for a `.ts` file, ESM
 * NodeNext style — the `.js` extension does NOT match the real `.ts` file
 * on disk literally). `resolveSpecifier()` below:
 *   1. Skips any specifier that does not start with `.` — a bare package
 *      name (`"lodash"`) or absolute alias is not part of the analyzed
 *      file set and cannot participate in a cycle this module can see.
 *      This is the single biggest source of under-reporting: a project
 *      using path aliases (tsconfig `paths`, webpack aliases) for
 *      internal imports will have those edges silently skipped, same as
 *      every bare-specifier import — safe direction (misses a real cycle
 *      routed through an alias), never fabricates one.
 *   2. Joins the specifier against the importing file's directory, then
 *      tries it verbatim, with a trailing `.js`/`.mjs`/`.cjs` stripped (the
 *      NodeNext case), and with each of a fixed extension list appended
 *      (directly and via `/index.<ext>`), checked against the *actual set
 *      of paths passed in* — not the filesystem. A specifier that matches
 *      no candidate is dropped (under-reports; never guesses a target).
 *   3. Ambiguity: if a base name resolves to more than one real extension
 *      (e.g. both `foo.ts` and `foo.tsx` are in the file set), the first
 *      match in `CANDIDATE_EXTENSIONS` order wins — same "don't guess
 *      beyond a documented, deterministic tie-break" posture as
 *      singleImplementation.ts's unbalanced-generic fallback.
 *
 * Name-based-resolution caveat: unlike the calls/refs tables (name-based
 * across files), import resolution here IS path-based, not name-based —
 * this is the one detector in this ticket whose edges are NOT subject to
 * the same-named-symbol-conflation risk. Its own risk is different: an
 * unresolvable specifier (alias, bare package) silently drops the edge
 * rather than conflating it with an unrelated file.
 *
 * Concrete-cycle reporting: for each strongly-connected component of size
 * >= 2, this module reports ONE representative simple cycle (shortest path
 * back to a chosen start node) plus the full `component` (every file
 * mutually reachable within it). An SCC can contain more than one simple
 * cycle — SCC membership is the exhaustive signal; the single `cycle` path
 * is a human-readable witness, not an enumeration of all cycles through
 * the component (full simple-cycle enumeration is exponential in the
 * worst case and out of scope here). A file that imports itself (rare —
 * e.g. a barrel re-exporting its own path) is reported separately as a
 * length-1 self-loop, since Tarjan's SCC algorithm alone would not
 * surface a self-loop on an otherwise-singleton component.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeDependencyCycles()` resolves to an array of
 * `DependencyCycleFinding` records:
 *
 * ```json
 * [{ "cycle": ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"],
 *    "length": 3, "component": ["src/a.ts", "src/b.ts", "src/c.ts"],
 *    "reason": "..." }]
 * ```
 */

export interface DependencyCycleFinding {
  /** File paths forming a concrete cycle; first and last entries are the
   *  same path (a -> b -> c -> a). */
  cycle: string[];
  /** Number of edges in `cycle` (cycle.length - 1). */
  length: number;
  /** Every file in the strongly-connected component `cycle` was drawn
   *  from, sorted — may be a superset of the files `cycle` visits (see
   *  module doc: an SCC can hold more than one simple cycle). */
  component: string[];
  reason: string;
}

const CANDIDATE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
];

function stripKnownJsExtension(spec: string): string {
  return spec.replace(/\.(m|c)?js$/i, "");
}

/** Resolve a raw import specifier from `fromPath` against `fileSet` (the
 *  exact set of paths passed in to computeDependencyCycles — no real
 *  filesystem access). Returns undefined for a bare/external specifier or
 *  one that matches nothing in the set — see module doc's under-report
 *  posture. */
function resolveSpecifier(
  fromPath: string,
  spec: string,
  fileSet: ReadonlySet<string>,
): string | undefined {
  if (!spec.startsWith(".")) return undefined;

  const fromDir = path.posix.dirname(fromPath.split(path.sep).join("/"));
  const joined = path.posix.normalize(path.posix.join(fromDir, spec));
  const stripped = stripKnownJsExtension(joined);

  const candidates = [joined, stripped];
  for (const ext of CANDIDATE_EXTENSIONS) candidates.push(stripped + ext);
  for (const ext of CANDIDATE_EXTENSIONS) {
    candidates.push(path.posix.join(joined, "index" + ext));
    candidates.push(path.posix.join(stripped, "index" + ext));
  }

  for (const c of candidates) {
    if (fileSet.has(c)) return c;
  }
  return undefined;
}

/** Build the resolved, deduplicated internal-import adjacency map for
 *  `files`. Exported (not just internal) so couplingOutliers.ts can reuse
 *  the identical resolution semantics for its file fan-in/fan-out
 *  distributions without re-deriving them differently. */
export async function buildResolvedImportGraph(
  files: Array<{ path: string; content: string }>,
): Promise<Map<string, Set<string>>> {
  const fileSet = new Set(files.map((f) => f.path));
  const adjacency = new Map<string, Set<string>>();
  for (const f of files) adjacency.set(f.path, new Set());

  for (const f of files) {
    const graph = await extractGraph(f.content, f.path);
    for (const imp of graph.imports) {
      const target = resolveSpecifier(f.path, imp.toPathOrModule, fileSet);
      if (!target) continue;
      adjacency.get(f.path)!.add(target);
    }
  }

  return adjacency;
}

/** Classic Tarjan's SCC algorithm, recursive (repo-scale file counts do
 *  not risk stack depth in practice). Returns every component with 2+
 *  members; singleton components (the overwhelmingly common case for a
 *  healthy import graph) are not returned — self-loops are handled
 *  separately by the caller. */
function tarjanSccs(adjacency: Map<string, Set<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlink.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indices.get(w)!));
      }
    }

    if (lowlink.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length >= 2) result.push(component);
    }
  }

  for (const v of adjacency.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }

  return result;
}

/** Shortest simple path from `start` to `goal`, using only edges between
 *  nodes in `allowed`. Undefined if no such path exists (should not happen
 *  for a genuine SCC, but this function makes no such assumption). */
function shortestPathWithin(
  start: string,
  goal: string,
  allowed: ReadonlySet<string>,
  adjacency: Map<string, Set<string>>,
): string[] | undefined {
  const prev = new Map<string, string | null>();
  prev.set(start, null);
  const queue: string[] = [start];
  let head = 0;

  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goal) {
      const out: string[] = [];
      let node: string | null = cur;
      while (node !== null) {
        out.unshift(node);
        node = prev.get(node) ?? null;
      }
      return out;
    }
    for (const next of adjacency.get(cur) ?? []) {
      if (!allowed.has(next)) continue;
      if (prev.has(next)) continue;
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return undefined;
}

/** One concrete, human-readable cycle witnessing SCC `component` — see
 *  module doc's "concrete-cycle reporting" section. Deterministic: sorts
 *  the component to pick a stable start node and sorts that node's
 *  in-component neighbors before trying each as the second hop. */
function representativeCycle(
  component: string[],
  adjacency: Map<string, Set<string>>,
): string[] {
  const sccSet = new Set(component);
  const sorted = [...component].sort();
  const start = sorted[0];
  const neighbors = [...(adjacency.get(start) ?? [])]
    .filter((n) => sccSet.has(n))
    .sort();

  for (const next of neighbors) {
    const rest = shortestPathWithin(next, start, sccSet, adjacency);
    if (rest) return [start, ...rest];
  }

  // Unreachable in practice for a real Tarjan-produced SCC of size >= 2
  // (every member has both an in- and out-edge within the component by
  // definition of strong connectivity) — defensive fallback only.
  return [start, ...sorted.filter((n) => n !== start), start];
}

function reasonForCycle(length: number): string {
  return (
    `${length} file(s) import each other in a cycle — see "component" for ` +
    `every file in the strongly-connected component, which may contain ` +
    `more than one concrete cycle; this is one witness path`
  );
}

const SELF_LOOP_REASON =
  "this file's own import graph resolves back to itself (a direct or " +
  "re-exported self-import)";

/**
 * Find import-graph cycles across `files`, file-level (see module doc).
 * Never throws — a file extractGraph() can't parse simply contributes no
 * imports.
 */
export async function computeDependencyCycles(
  files: Array<{ path: string; content: string }>,
): Promise<DependencyCycleFinding[]> {
  const adjacency = await buildResolvedImportGraph(files);

  const findings: DependencyCycleFinding[] = [];

  for (const [node, targets] of adjacency) {
    if (targets.has(node)) {
      findings.push({
        cycle: [node, node],
        length: 1,
        component: [node],
        reason: SELF_LOOP_REASON,
      });
    }
  }

  const sccs = tarjanSccs(adjacency);
  for (const component of sccs) {
    const cycle = representativeCycle(component, adjacency);
    findings.push({
      cycle,
      length: cycle.length - 1,
      component: [...component].sort(),
      reason: reasonForCycle(cycle.length - 1),
    });
  }

  findings.sort((a, b) => a.cycle[0].localeCompare(b.cycle[0]));
  return findings;
}
