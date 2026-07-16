import { describe, it, expect } from "vitest";
// A non-literal specifier (built at runtime) keeps this import out of tsc's
// static module graph for src/** (rootDir="src" in tsconfig.json forbids a
// file reachable from a src root file from resolving outside src/ when
// declaration output is on — eval/harness.ts lives outside src/ by design,
// see LODESTONE_DESIGN.md: eval/** is a sibling of src/**, not a subtree of
// it). vitest/esbuild still resolves and runs this at test time exactly
// like a static import; only tsc's rootDir enforcement is being routed
// around here. tsconfig.json itself is outside this ticket's write_scope.
const harnessSpecifier = "../../eval/harness.js";
type HarnessModule = {
  runGoldenEval: () => Promise<{ recallAt5: number; mrr: number }>;
};

/**
 * Regression guard for retrieval QUALITY, not correctness. query.test.ts in
 * this directory checks that query() (../search/query.ts) returns the right
 * *shape* (clusters with neighbors, graceful degradation, etc.); this test
 * checks that it returns the right *files* against a hand-judged golden set
 * (eval/golden.json, 16 judgments over the fixture repo at
 * eval/fixtures/sample-repo/) using Recall@5 and MRR (eval/metrics.ts). Two
 * of the 16 judgments are deliberately "ontology-only": their query terms
 * (e.g. argon2/pepper for password_storage, hs256/jwks/audience for
 * tokens_jwt) do not appear literally in the target file at all, so they
 * only resolve via ontology.expand() pulling in the concept's full term
 * list — a plain-BM25F-only implementation would fail those two, which is
 * the point (they make this guard sensitive to an ontology regression, not
 * just a chunking/ranking one).
 *
 * Floors are set just below the values measured on this fixture at the time
 * this guard was added (recall@5=0.906, MRR=0.437 — see eval/goldenEval.test.ts
 * for the full per-query report) so a chunking, BM25F, ontology-expansion, or
 * rank-adjustment regression trips this test without chasing exact-value
 * flakiness. The eval is fully deterministic (fixed fixture repo + a
 * deterministic fake embedding provider, no network) so there is no run-to-run
 * jitter to buffer against — the margin below is purely a tolerance band for
 * future, deliberate changes to the fixture or golden set.
 *
 * Optional broader benchmark: if this hand-picked golden set ever needs a
 * larger, more adversarial companion, CoIR (Code Information Retrieval
 * benchmark, https://github.com/CoIR-team/coir) is the standard cross-repo
 * NL->code retrieval suite — out of scope here; this fixture is sized for a
 * fast, hermetic CI gate, not a broad benchmark run.
 */

const RECALL_AT_5_FLOOR = 0.85;
const MRR_FLOOR = 0.4;

describe("golden retrieval regression guard", () => {
  it("keeps aggregate Recall@5 and MRR above the measured floor", async () => {
    const { runGoldenEval } = (await import(harnessSpecifier)) as HarnessModule;
    const report = await runGoldenEval();

    expect(report.recallAt5).toBeGreaterThanOrEqual(RECALL_AT_5_FLOOR);
    expect(report.mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  });
});
