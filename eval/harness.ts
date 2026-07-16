/**
 * Golden retrieval eval harness — indexes the fixture repo at
 * eval/fixtures/sample-repo, runs query() (src/search/query.ts, the Tier-1
 * retrieval pipeline, see LODESTONE_DESIGN.md §5) for every judgment in
 * eval/golden.json, and scores the results with Recall@k / MRR
 * (eval/metrics.ts).
 *
 * This is a retrieval-QUALITY eval, not a correctness test: it answers "does
 * query() surface the right files for a concept query", not "does the code
 * throw". Read-only against query()'s public API and CodeSearchDb's public
 * API -- nothing here touches search/chunker/ontology/db internals.
 *
 * Optional broader benchmark: CoIR (Code Information Retrieval benchmark,
 * https://github.com/CoIR-team/coir) is the standard cross-repo NL->code
 * retrieval suite if this hand-picked golden set needs a larger, more
 * adversarial companion later -- out of scope for this ticket (a pinned,
 * hand-judged fixture is what a regression guard needs; CoIR is a broader
 * quality benchmark, not a CI gate).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodeSearchDb } from "../src/db.js";
import { indexPath } from "../src/indexer.js";
import { query } from "../src/search/query.js";
import type { EmbeddingProvider } from "../src/embeddings/index.js";
import { recallAtK, reciprocalRank } from "./metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = path.join(__dirname, "fixtures", "sample-repo");
const GOLDEN_PATH = path.join(__dirname, "golden.json");

export interface GoldenJudgment {
  query: string;
  concept: string;
  relevant: string[];
}

export interface PerQueryResult {
  query: string;
  concept: string;
  relevant: string[];
  retrieved: string[];
  recallAt5: number;
  reciprocalRank: number;
}

export interface EvalReport {
  perQuery: PerQueryResult[];
  recallAt5: number;
  mrr: number;
  judgmentCount: number;
}

/**
 * Deterministic fake embedding provider -- no network, same pattern as
 * src/tests/query.test.ts's fakeProvider. Keeps the eval hermetic and fast;
 * the ranking signal under test here is BM25F + ontology expansion + graph
 * clustering, not embedding quality.
 */
const fakeProvider: EmbeddingProvider = {
  name: "eval-fake",
  dim: 8,
  async embed(texts: string[]) {
    return texts.map((t) => {
      const v = new Array(8).fill(0);
      for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 7;
      return v;
    });
  },
  async isAvailable() {
    return true;
  },
};

export function loadGoldenJudgments(): GoldenJudgment[] {
  const raw = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf-8"));
  return raw.judgments;
}

/** Absolute chunk path -> posix path relative to the fixture root, for
 *  comparison against golden.json's repo-relative "relevant" entries. */
function toRelativePosix(absolutePath: string): string {
  return path.relative(FIXTURE_ROOT, absolutePath).split(path.sep).join("/");
}

const RECALL_K = 5;

export async function runGoldenEval(): Promise<EvalReport> {
  const judgments = loadGoldenJudgments();
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "golden-eval-db-"));
  const db = new CodeSearchDb(path.join(dbDir, "index.db"));

  try {
    await indexPath(FIXTURE_ROOT, db, fakeProvider);
    // Exercise the vector kNN leg too (indexPath alone never calls
    // setProviderMeta -- see query.test.ts's third case for the same note).
    db.setProviderMeta({ name: fakeProvider.name, dim: fakeProvider.dim });

    const perQuery: PerQueryResult[] = [];
    for (const judgment of judgments) {
      const clusters = await query(db, judgment.query, fakeProvider, {
        topK: RECALL_K,
      });
      const retrieved = clusters.map((c) => toRelativePosix(c.primary.path));
      perQuery.push({
        query: judgment.query,
        concept: judgment.concept,
        relevant: judgment.relevant,
        retrieved,
        recallAt5: recallAtK(retrieved, judgment.relevant, RECALL_K),
        reciprocalRank: reciprocalRank(retrieved, judgment.relevant),
      });
    }

    const recallAt5 =
      perQuery.reduce((sum, r) => sum + r.recallAt5, 0) / perQuery.length;
    const mrr =
      perQuery.reduce((sum, r) => sum + r.reciprocalRank, 0) / perQuery.length;

    return { perQuery, recallAt5, mrr, judgmentCount: judgments.length };
  } finally {
    db.close();
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Golden retrieval eval -- ${report.judgmentCount} judgments`);
  lines.push("-".repeat(60));
  for (const r of report.perQuery) {
    lines.push(
      `[${r.concept}] "${r.query}"\n` +
        `  relevant:  ${r.relevant.join(", ")}\n` +
        `  retrieved: ${r.retrieved.join(", ") || "(none)"}\n` +
        `  recall@5=${r.recallAt5.toFixed(2)}  RR=${r.reciprocalRank.toFixed(2)}`,
    );
  }
  lines.push("-".repeat(60));
  lines.push(
    `Aggregate: recall@5=${report.recallAt5.toFixed(3)}  MRR=${report.mrr.toFixed(3)}`,
  );
  return lines.join("\n");
}
