import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import fs from "fs";
import { CodeSearchDb } from "../db.js";
import { indexPath } from "../indexer.js";
import type { EmbeddingProvider } from "../embeddings/index.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-fixture-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-db-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("symbol graph — end-to-end via indexPath on a fixture repo", () => {
  let repo: ReturnType<typeof tempRepo>;
  let dbHandle: ReturnType<typeof tempDb>;

  beforeEach(() => {
    repo = tempRepo();
    dbHandle = tempDb();

    fs.writeFileSync(
      path.join(repo.dir, "auth.ts"),
      `
import { hashPassword } from "./hash";

export function login(user: string): boolean {
  return verify(user);
}

function verify(user: string): boolean {
  return hashPassword(user).length > 0;
}

export function deadCode(): void {
  return;
}
`,
    );

    fs.writeFileSync(
      path.join(repo.dir, "hash.py"),
      `
import hashlib

def hash_password(user):
    return checksum(user)

def checksum(user):
    return hashlib.sha256(user.encode()).hexdigest()

def dead_code():
    return None
`,
    );

    // Cross-file usage: helperFn is defined here...
    fs.writeFileSync(
      path.join(repo.dir, "util.ts"),
      `
export function helperFn(): number {
  return 1;
}
`,
    );
    // ...and only ever referenced from a different file.
    fs.writeFileSync(
      path.join(repo.dir, "consumer.ts"),
      `
import { helperFn } from "./util";

export function run(): number {
  return helperFn();
}
`,
    );
  });

  afterEach(() => {
    repo.cleanup();
    dbHandle.cleanup();
  });

  it("indexes all fixture files without errors", async () => {
    const result = await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(result.errors).toEqual([]);
    expect(result.indexed).toBe(4);
  });

  it("refs are a global (cross-file) xref: 'helperFn' is defined in util.ts and only referenced from consumer.ts", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(dbHandle.db.queryDefs("helperFn").length).toBeGreaterThan(0);
    const refs = dbHandle.db.queryRefs("helperFn");
    expect(refs.length).toBeGreaterThan(0);
    expect(
      refs.some((r) => r.path === path.join(repo.dir, "consumer.ts")),
    ).toBe(true);
  });

  it("(a) who calls X: 'verify' resolves to caller 'login' (TypeScript)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const callers = dbHandle.db.queryCallers("verify");
    expect(callers.map((c) => c.caller)).toContain("login");
  });

  it("(a) who calls X: 'checksum' resolves to caller 'hash_password' (Python)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const callers = dbHandle.db.queryCallers("checksum");
    expect(callers.map((c) => c.caller)).toContain("hash_password");
  });

  it("(b) is export Y unused: 'deadCode' has a def and zero refs (TypeScript)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const defs = dbHandle.db.queryDefs("deadCode");
    expect(defs.length).toBeGreaterThan(0);
    expect(dbHandle.db.queryRefs("deadCode")).toEqual([]);
  });

  it("(b) is export Y unused: 'dead_code' has a def and zero refs (Python)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const defs = dbHandle.db.queryDefs("dead_code");
    expect(defs.length).toBeGreaterThan(0);
    expect(dbHandle.db.queryRefs("dead_code")).toEqual([]);
  });

  it("a used def ('login') is not mistaken for dead code — has defs, may have zero in-repo refs but is not our dead-code fixture", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const defs = dbHandle.db.queryDefs("login");
    expect(defs.length).toBeGreaterThan(0);
  });

  it("(c) imports are captured for both files", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const tsImports = dbHandle.db.queryImports(path.join(repo.dir, "auth.ts"));
    expect(tsImports).toContainEqual(
      expect.objectContaining({ toPathOrModule: "./hash" }),
    );
    const pyImports = dbHandle.db.queryImports(path.join(repo.dir, "hash.py"));
    expect(pyImports).toContainEqual(
      expect.objectContaining({ toPathOrModule: "hashlib" }),
    );
  });

  it("re-indexing an unchanged file does not duplicate graph rows (mtime skip)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    const before = dbHandle.db.defCount();
    const result = await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(result.skipped).toBe(4);
    expect(dbHandle.db.defCount()).toBe(before);
  });

  it("re-indexing a changed file replaces its graph rows without leaking stale ones", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(dbHandle.db.queryDefs("deadCode").length).toBe(1);

    // Touch mtime forward and remove the dead function.
    const authPath = path.join(repo.dir, "auth.ts");
    fs.writeFileSync(
      authPath,
      `
export function login(user: string): boolean {
  return true;
}
`,
    );
    const future = Date.now() / 1000 + 5;
    fs.utimesSync(authPath, future, future);

    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(dbHandle.db.queryDefs("deadCode")).toEqual([]);
  });

  it("does not break existing chunk/symbol indexing (additive)", async () => {
    await indexPath(repo.dir, dbHandle.db, fakeProvider);
    expect(dbHandle.db.chunkCount()).toBeGreaterThan(0);
    expect(dbHandle.db.symbolCount()).toBeGreaterThan(0);
  });
});
