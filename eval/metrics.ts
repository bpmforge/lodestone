/**
 * Retrieval-quality metrics (Recall@k, MRR) — pure functions over ranked
 * path lists. No dependency on CodeSearchDb/query() so they're independently
 * unit-testable and reusable outside this eval (see LODESTONE_DESIGN.md §5:
 * this is the Tier-1 retrieval quality gate, distinct from the correctness
 * tests in src/tests/query.test.ts).
 */

/**
 * Recall@k = |top-k retrieved paths ∩ relevant paths| / |relevant paths|.
 * `retrieved` is assumed already ranked best-first; only the first `k`
 * entries are considered. Returns 1 when `relevant` is empty (nothing to
 * miss) so a malformed judgment can't silently deflate the aggregate.
 */
export function recallAtK(
  retrieved: string[],
  relevant: string[],
  k: number,
): number {
  if (relevant.length === 0) return 1;
  const topK = new Set(retrieved.slice(0, k));
  const hits = relevant.filter((r) => topK.has(r)).length;
  return hits / relevant.length;
}

/**
 * Reciprocal rank of the first relevant hit in `retrieved` (rank 1 = first
 * position). 0 when no relevant path appears anywhere in `retrieved`.
 */
export function reciprocalRank(
  retrieved: string[],
  relevant: string[],
): number {
  const relevantSet = new Set(relevant);
  for (let i = 0; i < retrieved.length; i++) {
    if (relevantSet.has(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
