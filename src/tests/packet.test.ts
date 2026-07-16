import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import { evidencePacket } from "../packet/index.js";
import type { EmbeddingProvider } from "../embeddings/index.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packet-fixture-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packet-db-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("evidencePacket() — chunk + call-graph neighborhood + concept, on a seeded finding", () => {
  let repo: ReturnType<typeof tempRepo>;
  let dbHandle: ReturnType<typeof tempDb>;
  let authPath: string;

  beforeEach(async () => {
    repo = tempRepo();
    dbHandle = tempDb();
    authPath = path.join(repo.dir, "auth.ts");

    fs.writeFileSync(
      authPath,
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

    // Config-file indexing hasn't landed yet (indexer.ts's DEFAULT_INCLUDE
    // has no .yml glob), so a config ref can only exist via direct
    // insertion — seed one to exercise the classifier honestly rather than
    // asserting on a path that can never be non-empty end-to-end.
    dbHandle.db.insertRefs([
      {
        symbol: "hashPassword",
        path: path.join(repo.dir, "security.yml"),
        line: 3,
        fileMtime: 0,
      },
    ]);
  });

  afterEach(() => {
    repo.cleanup();
    dbHandle.cleanup();
  });

  it("returns chunk + callers + callees + config refs + concept, all with path:line", async () => {
    // Find the def line the indexer recorded for hashPassword.
    const [def] = dbHandle.db.queryDefs("hashPassword");
    expect(def).toBeDefined();

    const packet = await evidencePacket(dbHandle.db, {
      path: authPath,
      line: def!.startLine,
      concept: "password_storage",
      ruleId: "test-rule",
    });

    // Chunk: the finding's own site, with path:line.
    expect(packet.chunk.path).toBe(authPath);
    expect(packet.chunk.text).toContain("hashPassword");
    expect(typeof packet.chunk.startLine).toBe("number");
    expect(typeof packet.chunk.endLine).toBe("number");

    // Callers: login.ts calls hashPassword.
    expect(packet.callers.length).toBeGreaterThan(0);
    expect(
      packet.callers.some(
        (c) => c.path.endsWith("login.ts") && typeof c.line === "number",
      ),
    ).toBe(true);

    // Callees: hashPassword calls normalize.
    expect(packet.callees.length).toBeGreaterThan(0);
    expect(
      packet.callees.some(
        (c) => c.symbol === "normalize" && typeof c.line === "number",
      ),
    ).toBe(true);

    // Config refs: the seeded security.yml reference to hashPassword.
    expect(packet.configRefs.length).toBeGreaterThan(0);
    expect(
      packet.configRefs.some(
        (c) => c.path.endsWith("security.yml") && c.line === 3,
      ),
    ).toBe(true);

    // Concept: mapped via the explicit finding.concept seed, including the
    // CWE anchors the ontology carries for report traceability.
    expect(packet.concept.concepts).toContain("password_storage");
    expect(packet.concept.terms).toEqual(
      expect.arrayContaining(["hash", "bcrypt"]),
    );
    expect(packet.concept.cwe).toEqual(expect.arrayContaining([256, 257, 916]));

    // Reliability flag: auth.ts is TypeScript — cross-file graph is reliable.
    expect(packet.crossFileGraphReliable).toBe(true);
  });

  it("flags crossFileGraphReliable=false for a language outside the tree-sitter-verified xref set", async () => {
    const swiftPath = path.join(repo.dir, "widget.swift");
    fs.writeFileSync(swiftPath, `func doThing() {\n  print("hi")\n}\n`);
    await indexPath(repo.dir, dbHandle.db, fakeProvider);

    const packet = await evidencePacket(dbHandle.db, {
      path: swiftPath,
      line: 1,
    });
    expect(packet.crossFileGraphReliable).toBe(false);
  });

  it("falls back to a raw slice (never throws) when the file is missing on disk", async () => {
    const missingPath = path.join(repo.dir, "does-not-exist.ts");
    const packet = await evidencePacket(dbHandle.db, {
      path: missingPath,
      line: 5,
    });
    expect(packet.chunk.path).toBe(missingPath);
    expect(packet.chunk.text).toBe("");
    expect(packet.callers).toEqual([]);
  });
});
