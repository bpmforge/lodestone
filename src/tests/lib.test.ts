import { describe, it, expect } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import * as lib from "../lib.js";
import * as compat from "../index.js";
import type { EmbeddingProvider } from "../embeddings/index.js";

/**
 * W3-10: src/lib.ts is the library barrel a git-dependency consumer
 * imports; src/index.ts is a compat re-export of it. Neither may have a
 * side effect on import (no DB connection, no MCP transport connect) — the
 * bug this ticket fixes is src/index.ts having BEEN the MCP server itself.
 * src/mcp.ts (the actual server, which DOES connect on import) is exercised
 * by hand — see PR handoff notes — not here, since importing it would hang
 * the test process waiting on stdio.
 */

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-fixture-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tempDb(): { db: lib.CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-db-"));
  const db = new lib.CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("src/lib.ts barrel", () => {
  it("exports the full Tier-1/Tier-2 API surface named in the ticket", () => {
    expect(typeof lib.query).toBe("function");
    expect(typeof lib.evidencePacket).toBe("function");
    expect(typeof lib.coverageGaps).toBe("function");
    expect(typeof lib.indexPath).toBe("function");
    expect(typeof lib.CodeSearchDb).toBe("function");
    expect(typeof lib.ontology.expand).toBe("function");
    expect(typeof lib.ontology.loadOntology).toBe("function");
    expect(typeof lib.computeComplexity).toBe("function");
    expect(typeof lib.computeDuplication).toBe("function");
    expect(typeof lib.computeDeadCode).toBe("function");
    expect(typeof lib.computeSingleImplementation).toBe("function");
    expect(typeof lib.computeSingleUseHelper).toBe("function");
    expect(typeof lib.computePhantomImports).toBe("function");
    expect(typeof lib.detectProvider).toBe("function");
  });

  it("src/index.ts re-exports the same names as src/lib.ts (compat shim)", () => {
    expect(Object.keys(compat).sort()).toEqual(Object.keys(lib).sort());
  });

  it("ontology.expand resolves the default concepts.yaml regardless of caller depth", () => {
    // Regression guard for the bundling bug this ticket fixed: a fixed
    // `../../` relative to the module file broke once tsup flattened
    // everything into dist/*.js. findPackageRoot() walks up to the nearest
    // package.json instead, so this must resolve concepts whether run from
    // src/ (vitest, here) or a bundled dist/*.js (verified separately
    // against the built package — see PR handoff).
    const result = lib.ontology.expand("password auth token");
    expect(result.concepts.length).toBeGreaterThan(0);
  });

  it("drives query()/evidencePacket()/coverageGaps()/indexPath() end-to-end via the barrel only", async () => {
    const repo = tempRepo();
    const dbFixture = tempDb();
    try {
      fs.writeFileSync(
        path.join(repo.dir, "auth.ts"),
        `export function hashPassword(pw: string): string {\n  return pw.split("").reverse().join("");\n}\n`,
      );

      const indexResult = await lib.indexPath(
        repo.dir,
        dbFixture.db,
        fakeProvider,
      );
      expect(indexResult.indexed).toBeGreaterThanOrEqual(1);

      const clusters = await lib.query(
        dbFixture.db,
        "password hashing",
        fakeProvider,
        {
          topK: 3,
        },
      );
      expect(Array.isArray(clusters)).toBe(true);

      const packet = await lib.evidencePacket(dbFixture.db, {
        path: path.join(repo.dir, "auth.ts"),
        line: 1,
        message: "password hashing",
      });
      expect(packet.chunk).toBeDefined();

      const gaps = lib.coverageGaps(dbFixture.db, []);
      expect(Array.isArray(gaps)).toBe(true);
    } finally {
      dbFixture.cleanup();
      repo.cleanup();
    }
  });
});
