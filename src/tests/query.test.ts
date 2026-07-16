import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import { rrfFuse } from "../search.js";
import { query, rankAdjust } from "../search/query.js";
import type { EmbeddingProvider } from "../embeddings/index.js";
import type { SearchResult } from "../db.js";

/** Deterministic fake provider — no network, fixed-dim zero-ish vectors. */
const fakeProvider: EmbeddingProvider = {
  name: "fake",
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

function tempRepo(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "query-fixture-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "query-db-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function mk(id: number, filePath: string, score: number): SearchResult {
  return {
    id,
    filePath,
    chunkText: `chunk ${id}`,
    startLine: 1,
    endLine: 2,
    fileMtime: 0,
    embeddingProvider: "x",
    score,
  };
}

describe("query() — clustered retrieval on a fixture repo", () => {
  let repo: ReturnType<typeof tempRepo>;
  let dbHandle: ReturnType<typeof tempDb>;

  beforeEach(async () => {
    repo = tempRepo();
    dbHandle = tempDb();

    fs.writeFileSync(
      path.join(repo.dir, "auth.ts"),
      `
export function hashPassword(pw: string): string {
  return normalize(pw);
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}
`,
    );

    fs.writeFileSync(
      path.join(repo.dir, "login.ts"),
      `
import { hashPassword } from "./auth";

export function login(user: string, pw: string): boolean {
  return hashPassword(pw).length > 0;
}
`,
    );

    await indexPath(repo.dir, dbHandle.db, fakeProvider);
  });

  afterEach(() => {
    repo.cleanup();
    dbHandle.cleanup();
  });

  it("(a) 'where is X' returns a clustered result — not a flat list — with real neighbors", async () => {
    const clusters = await query(dbHandle.db, "hashPassword", fakeProvider, {
      topK: 5,
    });

    expect(clusters.length).toBeGreaterThan(0);
    const top = clusters[0]!;
    // Structural shape: a primary site plus a neighbor list, not a bare hit array.
    expect(top).toHaveProperty("primary");
    expect(top).toHaveProperty("neighbors");
    expect(top.primary.chunkText).toContain("hashPassword");
    expect(top.primary.symbols).toContain("hashPassword");
    expect(top.primary.crossFileGraphReliable).toBe(true);

    // 1-hop neighbors: login.ts calls hashPassword (caller), hashPassword
    // itself calls normalize (callee).
    expect(top.neighbors.length).toBeGreaterThan(0);
    expect(
      top.neighbors.some(
        (n) => n.relation === "caller" && n.path.endsWith("login.ts"),
      ),
    ).toBe(true);
    expect(
      top.neighbors.some(
        (n) => n.relation === "callee" && n.symbol === "normalize",
      ),
    ).toBe(true);
    // Every neighbor carries path:line.
    for (const n of top.neighbors) {
      expect(typeof n.path).toBe("string");
      expect(typeof n.line).toBe("number");
    }
  });

  it("degrades gracefully to an empty cluster list for a query matching nothing", async () => {
    const clusters = await query(dbHandle.db, "zzz_no_such_symbol_zzz", null, {
      topK: 5,
    });
    expect(clusters).toEqual([]);
  });

  it("still returns results when the vector kNN path is live (provider meta set)", async () => {
    // indexPath() alone never calls setProviderMeta (only the MCP server's
    // getProvider() does — see index.ts), so without this the vector side
    // of query() is always skipped in these fixtures. Exercise it directly.
    dbHandle.db.setProviderMeta({ name: "fake", dim: 8 });
    const clusters = await query(dbHandle.db, "hashPassword", fakeProvider, {
      topK: 5,
    });
    expect(clusters.length).toBeGreaterThan(0);
  });
});

describe("(c) RRF fusion + rank adjustments — definitions rank above test-file hits", () => {
  let dbHandle: ReturnType<typeof tempDb>;

  beforeEach(() => (dbHandle = tempDb()));
  afterEach(() => dbHandle.cleanup());

  it("flips a pre-adjustment ordering where the test-file hit ranked first", () => {
    const { db } = dbHandle;
    const testHit = mk(1, "/auth/service.test.ts", 1);
    const defHit = mk(2, "/auth/service.ts", 1);

    // Simulate the FTS ranking pass: the test file matched at rank 0 (e.g.
    // repeats the term many times in comments/body), the definition file at
    // rank 1 — RRF alone should NOT already favor the definition.
    const fused = rrfFuse([[testHit, defHit]], 10);
    expect(fused[0]!.filePath).toBe("/auth/service.test.ts");
    expect(fused[1]!.filePath).toBe("/auth/service.ts");

    db.insertDefs([
      {
        symbol: "authenticate",
        path: "/auth/service.ts",
        startLine: 1,
        endLine: 2,
        kind: "function",
        fileMtime: 0,
      },
    ]);

    const adjusted = rankAdjust(db, fused, new Set(["authenticate"]));
    expect(adjusted[0]!.filePath).toBe("/auth/service.ts");
    expect(adjusted[1]!.filePath).toBe("/auth/service.test.ts");
  });

  it("does not boost a chunk with no matching def and still penalizes a vendored path", () => {
    const { db } = dbHandle;
    const vendorHit = mk(1, "/vendor/lib.js", 1);
    const plainHit = mk(2, "/src/lib.js", 1);
    const fused = rrfFuse([[vendorHit, plainHit]], 10);
    const adjusted = rankAdjust(db, fused, new Set(["nothingMatches"]));
    expect(adjusted[0]!.filePath).toBe("/src/lib.js");
  });
});
