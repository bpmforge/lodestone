import { describe, it, expect } from "vitest";
import { runGoldenEval, formatReport } from "./harness.js";

/**
 * Runs the golden retrieval eval and prints a per-query + aggregate report.
 * This is the "run.mjs" of the ticket: a standalone, human-readable report,
 * runnable in isolation via `npx vitest run eval/goldenEval.test.ts`. The
 * regression guard that gates on these numbers lives separately in
 * src/tests/goldenRetrieval.test.ts (see that file for the floor and why).
 *
 * Sanity-only here (no floor assertions) -- this file's job is reporting,
 * not gating.
 */
describe("golden retrieval eval — report", () => {
  it("indexes the fixture repo and scores every golden judgment", async () => {
    const report = await runGoldenEval();
    // eslint-disable-next-line no-console
    console.log("\n" + formatReport(report));

    expect(report.judgmentCount).toBeGreaterThanOrEqual(8);
    expect(report.perQuery).toHaveLength(report.judgmentCount);
    for (const r of report.perQuery) {
      expect(r.recallAt5).toBeGreaterThanOrEqual(0);
      expect(r.recallAt5).toBeLessThanOrEqual(1);
      expect(r.reciprocalRank).toBeGreaterThanOrEqual(0);
      expect(r.reciprocalRank).toBeLessThanOrEqual(1);
    }
  });
});
