import { CodeSearchDb, type SearchResult } from "./db.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { providerFromMeta } from "./embeddings/index.js";

export interface SearchOptions {
  topK?: number;
  pathFilter?: string;
}

const RRF_K = 60; // Reciprocal Rank Fusion constant (standard default)
const OVERFETCH = 4; // pull deeper from each side before fusing/filtering

/**
 * Build an FTS5-safe query from arbitrary text. A natural-language query like
 * `how does auth work?` contains characters FTS5 treats as operators and would
 * throw on — so quote each word token and OR them together.
 */
export function toFtsQuery(text: string): string {
  const terms = text.match(/[A-Za-z0-9_]+/g) ?? [];
  return terms.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Reciprocal Rank Fusion over N ranked lists, keyed by chunk id. Each list
 * contributes 1/(RRF_K + rank) to a chunk's score; the fused score replaces the
 * per-engine score. RRF needs no score normalization across engines (cosine vs
 * BM25), which is why it's the standard hybrid-search fuser.
 */
export function rrfFuse(
  lists: SearchResult[][],
  limit: number,
): SearchResult[] {
  const acc = new Map<number, { r: SearchResult; s: number }>();
  for (const list of lists) {
    list.forEach((r, rank) => {
      const inc = 1 / (RRF_K + rank + 1);
      const cur = acc.get(r.id);
      if (cur) cur.s += inc;
      else acc.set(r.id, { r, s: inc });
    });
  }
  return [...acc.values()]
    .map(({ r, s }) => ({ ...r, score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function ftsSafe(
  db: CodeSearchDb,
  query: string,
  topK: number,
): SearchResult[] {
  const fq = toFtsQuery(query);
  if (!fq) return [];
  try {
    return db.searchFts(fq, topK);
  } catch {
    return [];
  }
}

/**
 * Hybrid search: fuse semantic (vector) and keyword (FTS/BM25) rankings with
 * RRF. Vector catches meaning ("how do we handle auth"); FTS catches exact
 * identifiers a paraphrased embedding can miss. Degrades cleanly: no
 * embedder/index → keyword-only; empty keyword hits → vector-only.
 */
export async function search(
  query: string,
  db: CodeSearchDb,
  activeProvider: EmbeddingProvider | null,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const topK = options.topK ?? 10;
  const meta = db.getProviderMeta();

  // Keyword ranking — always available, FTS5-safe.
  const ftsResults = ftsSafe(db, query, topK * OVERFETCH);

  // Semantic ranking — only when an index + a matching provider exist.
  let vecResults: SearchResult[] = [];
  if (meta) {
    let provider = activeProvider;
    if (!provider || provider.name !== meta.name || provider.dim !== meta.dim) {
      try {
        provider = providerFromMeta(meta);
      } catch {
        provider = null;
      }
    }
    if (provider) {
      try {
        const [[queryEmbedding]] = [await provider.embed([query])];
        vecResults = db.search(
          new Float32Array(queryEmbedding),
          topK * OVERFETCH,
        );
      } catch {
        // Embedder went away mid-session — the keyword side carries the query.
      }
    }
  }

  // Fuse when both sides produced hits; otherwise use whichever did.
  let fused: SearchResult[];
  if (vecResults.length && ftsResults.length) {
    fused = rrfFuse([vecResults, ftsResults], topK * OVERFETCH);
  } else {
    fused = vecResults.length ? vecResults : ftsResults;
  }

  if (options.pathFilter) {
    const f = options.pathFilter.toLowerCase();
    fused = fused.filter((r) => r.filePath.toLowerCase().includes(f));
  }
  return fused.slice(0, topK);
}
