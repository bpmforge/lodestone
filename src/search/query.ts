import type { CodeSearchDb, SearchResult } from "../db.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import { providerFromMeta } from "../embeddings/index.js";
import { toFtsQuery, rrfFuse } from "../search.js";
import { expand } from "../ontology/index.js";
import { isCrossFileGraphReliable } from "./graphReliability.js";
import { symbolsInRange } from "./symbolsInRange.js";

/**
 * Tier-1 retrieval pipeline (see docs/LODESTONE_DESIGN.md §5): zero-LLM
 * query -> clustered evidence. Consumes the BM25F FTS columns (W3-02), the
 * cAST chunker (W3-03, consumed indirectly via the chunks table), the
 * symbol graph (W3-04), and the concept ontology (W3-05); adds nothing to
 * any of those tables/schemas — read-only against CodeSearchDb's public API.
 *
 *   ontology.expand(q)
 *     -> parallel: BM25F(expanded, symbols-boosted) | vector.kNN(q) | exact-identifier
 *     -> RRF(k=60)              (rrfFuse, reused from ../search.js)
 *     -> rank adjust: +definitions, -test/vendored/generated, +call-graph centrality
 *     -> graph.expand(top-N, 1-hop callers/callees + same-symbol refs)
 *     -> Cluster[]
 */

export interface QueryOptions {
  /** Number of clusters to return. Default 5. */
  topK?: number;
  pathFilter?: string;
}

export type NeighborRelation = "caller" | "callee" | "ref" | "config";

export interface ClusterNeighbor {
  symbol: string;
  path: string;
  line: number;
  relation: NeighborRelation;
}

export interface ClusterPrimary {
  chunkId: number;
  path: string;
  startLine: number;
  endLine: number;
  chunkText: string;
  score: number;
  /** Symbols the index recorded as declared within this chunk's range. */
  symbols: string[];
  /** See graphReliability.ts. False => the neighbor list below may be
   *  missing legitimate cross-file callers/refs (regex-tier language) —
   *  don't read a short/empty neighbor list as "this is dead code". */
  crossFileGraphReliable: boolean;
}

export interface Cluster {
  primary: ClusterPrimary;
  neighbors: ClusterNeighbor[];
}

const RRF_OVERFETCH = 4;
const MAX_NEIGHBORS_PER_CLUSTER = 20;

// Rank-adjustment weights. RRF scores are O(1/60) ~ 0.016 per contributing
// list, so these boosts/penalties are sized to dominate that range and
// reliably reorder same-tier RRF ties/near-ties — see query.test.ts (c).
const DEF_BOOST = 0.05;
const TEST_PENALTY = 0.03;
const VENDOR_GENERATED_PENALTY = 0.05;
const CENTRALITY_WEIGHT = 0.002; // per in-repo caller, capped below
const MAX_CENTRALITY_BONUS = 0.02;

const TEST_FILE_RE =
  /(^|[\\/])(tests?|__tests__|__mocks__|spec|fixtures?)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_[^\\/]+\.py$|_test\.py$/i;
const VENDOR_GENERATED_RE =
  /(^|[\\/])(vendor|vendored|node_modules|dist|build|generated|\.generated)([\\/]|$)|\.gen\.[jt]sx?$|\.min\.js$/i;
const CONFIG_FILE_RE = /\.(ya?ml|json|toml|ini|cfg|conf|env)$/i;

function ftsSafe(
  db: CodeSearchDb,
  ftsQuery: string,
  topK: number,
): SearchResult[] {
  if (!ftsQuery) return [];
  try {
    return db.searchFts(ftsQuery, topK);
  } catch {
    return [];
  }
}

/**
 * Identifier-shaped raw tokens from free text, worth a direct
 * searchFtsForName() lookup ("exact-identifier match"). Deliberately
 * unfiltered beyond a length floor — a false-positive candidate just costs
 * one harmless empty lookup, not a correctness bug.
 */
function identifierCandidates(q: string): string[] {
  const raw = q.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(raw.filter((t) => t.length >= 3))];
}

async function vectorResults(
  db: CodeSearchDb,
  q: string,
  activeProvider: EmbeddingProvider | null,
  topK: number,
): Promise<SearchResult[]> {
  const meta = db.getProviderMeta();
  if (!meta) return [];
  let provider = activeProvider;
  if (!provider || provider.name !== meta.name || provider.dim !== meta.dim) {
    try {
      provider = providerFromMeta(meta);
    } catch {
      return [];
    }
  }
  try {
    const [queryEmbedding] = await provider.embed([q]);
    return db.search(new Float32Array(queryEmbedding), topK);
  } catch {
    // Embedder unavailable mid-session — the keyword/exact sides carry the query.
    return [];
  }
}

function exactIdentifierResults(
  db: CodeSearchDb,
  terms: string[],
  topK: number,
): SearchResult[] {
  const acc = new Map<number, SearchResult>();
  for (const term of terms) {
    for (const r of db.searchFtsForName(term, topK)) {
      if (!acc.has(r.id)) acc.set(r.id, r);
    }
  }
  return [...acc.values()];
}

/**
 * True when a def of one of `candidateNames` falls within [startLine,
 * endLine] of `filePath`. CodeSearchDb has no "defs in file+range" query —
 * only `queryDefs(exact symbol name)` — so the definition boost is scoped
 * to names the query already cares about (its own identifiers + expanded
 * ontology terms) rather than every def in the repo.
 */
function isDefinitionSite(
  db: CodeSearchDb,
  filePath: string,
  startLine: number,
  endLine: number,
  candidateNames: Set<string>,
): boolean {
  for (const name of candidateNames) {
    const defs = db.queryDefs(name);
    if (
      defs.some(
        (d) =>
          d.path === filePath &&
          d.startLine >= startLine &&
          d.startLine <= endLine,
      )
    ) {
      return true;
    }
  }
  return false;
}

function pathPenalty(filePath: string): number {
  let penalty = 0;
  if (TEST_FILE_RE.test(filePath)) penalty += TEST_PENALTY;
  if (VENDOR_GENERATED_RE.test(filePath)) penalty += VENDOR_GENERATED_PENALTY;
  return penalty;
}

/**
 * Call-graph fan-in for the symbols this chunk declares, as a proxy for
 * "+import-graph centrality". CodeSearchDb exposes no list-all-imports or
 * list-all-files method and import specifiers are frequently unresolved
 * relative strings (`./hash`), so true file-level import centrality isn't
 * computable from the public API without a filesystem walk this module
 * doesn't have inputs for. In-repo caller count (defs/calls tables, W3-04)
 * is the closest available signal and correlates with import centrality in
 * practice — a symbol with many callers is almost always imported from many
 * places too.
 */
function centralityBonus(
  db: CodeSearchDb,
  filePath: string,
  startLine: number,
  endLine: number,
): number {
  const own = symbolsInRange(db, filePath, startLine, endLine);
  let callers = 0;
  for (const s of own) callers += db.queryCallers(s.name).length;
  return Math.min(callers * CENTRALITY_WEIGHT, MAX_CENTRALITY_BONUS);
}

/**
 * Rank-adjustment pass applied after RRF fusion: +definitions of
 * `candidateNames`, -test/vendored/generated paths, +call-graph centrality.
 * Exported (alongside `query`) as the same kind of testable internal
 * building block ../search.js exposes via rrfFuse/toFtsQuery.
 */
export function rankAdjust(
  db: CodeSearchDb,
  results: SearchResult[],
  candidateNames: Set<string>,
): SearchResult[] {
  const adjusted = results.map((r) => {
    let score = r.score;
    score -= pathPenalty(r.filePath);
    if (
      isDefinitionSite(db, r.filePath, r.startLine, r.endLine, candidateNames)
    ) {
      score += DEF_BOOST;
    }
    score += centralityBonus(db, r.filePath, r.startLine, r.endLine);
    return { ...r, score };
  });
  return adjusted.sort((a, b) => b.score - a.score);
}

/**
 * 1-hop callers/callees + same-symbol refs (graph tables, W3-04) for a
 * ranked chunk's own declared symbols. Refs that land on a config-like
 * extension are classified "config"; a ref at the same (path,line,symbol)
 * as an already-recorded caller edge is skipped (calls are also recorded
 * as refs by the tree-sitter tier — see graph.ts — so this avoids listing
 * the same call site twice under two relations).
 */
function buildCluster(db: CodeSearchDb, r: SearchResult): Cluster {
  const own = symbolsInRange(db, r.filePath, r.startLine, r.endLine);
  const seen = new Set<string>();
  const neighbors: ClusterNeighbor[] = [];

  const add = (
    symbol: string,
    path: string,
    line: number,
    relation: NeighborRelation,
  ) => {
    if (neighbors.length >= MAX_NEIGHBORS_PER_CLUSTER) return;
    const key = `${relation}:${path}:${line}:${symbol}`;
    if (seen.has(key)) return;
    seen.add(key);
    neighbors.push({ symbol, path, line, relation });
  };

  for (const s of own) {
    for (const c of db.queryCallers(s.name))
      add(s.name, c.path, c.line, "caller");
    for (const c of db.queryCallees(s.name))
      add(c.callee, c.path, c.line, "callee");
    for (const ref of db.queryRefs(s.name)) {
      if (CONFIG_FILE_RE.test(ref.path)) {
        add(s.name, ref.path, ref.line, "config");
        continue;
      }
      if (seen.has(`caller:${ref.path}:${ref.line}:${s.name}`)) continue;
      add(s.name, ref.path, ref.line, "ref");
    }
  }

  return {
    primary: {
      chunkId: r.id,
      path: r.filePath,
      startLine: r.startLine,
      endLine: r.endLine,
      chunkText: r.chunkText,
      score: r.score,
      symbols: own.map((s) => s.name),
      crossFileGraphReliable: isCrossFileGraphReliable(r.filePath),
    },
    neighbors,
  };
}

/**
 * Tier-1 retrieval entry point — see module doc above. Never throws:
 * degrades to whichever of BM25F/vector/exact-identifier produced hits, the
 * same way ../search.js's `search()` degrades.
 */
export async function query(
  db: CodeSearchDb,
  q: string,
  activeProvider: EmbeddingProvider | null = null,
  options: QueryOptions = {},
): Promise<Cluster[]> {
  const topK = options.topK ?? 5;
  const overfetch = topK * RRF_OVERFETCH;

  const expanded = expand(q);
  const bm25Query = toFtsQuery([q, ...expanded.terms].join(" "));
  const bm25Results = ftsSafe(db, bm25Query, overfetch);

  const vecResults = await vectorResults(db, q, activeProvider, overfetch);

  const candidateNames = new Set([
    ...identifierCandidates(q),
    ...expanded.terms,
  ]);
  const exactResults = exactIdentifierResults(
    db,
    [...candidateNames],
    overfetch,
  );

  const lists = [bm25Results, vecResults, exactResults].filter(
    (l) => l.length > 0,
  );
  let fused = lists.length ? rrfFuse(lists, overfetch) : [];

  if (options.pathFilter) {
    const f = options.pathFilter.toLowerCase();
    fused = fused.filter((r) => r.filePath.toLowerCase().includes(f));
  }

  const adjusted = rankAdjust(db, fused, candidateNames);
  return adjusted.slice(0, topK).map((r) => buildCluster(db, r));
}
