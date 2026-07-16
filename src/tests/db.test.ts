import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodeSearchDb } from "../db.js";
import os from "os";
import path from "path";
import fs from "fs";

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-search-test-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true });
    },
  };
}

describe("CodeSearchDb", () => {
  let db: CodeSearchDb;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, cleanup } = tempDb());
  });

  afterEach(() => cleanup());

  it("starts with no provider meta", () => {
    expect(db.getProviderMeta()).toBeNull();
  });

  it("stores and retrieves provider meta", () => {
    db.setProviderMeta({ name: "lm-studio", dim: 768 });
    expect(db.getProviderMeta()).toEqual({ name: "lm-studio", dim: 768 });
  });

  it("inserts chunks and counts them", () => {
    const embedding = new Float32Array(768).fill(0.1);
    db.insertChunks([
      {
        filePath: "/test/foo.ts",
        chunkText: "export function hello() { return 42; }",
        startLine: 1,
        endLine: 3,
        fileMtime: 1000,
        embeddingProvider: "lm-studio",
        embedding,
      },
    ]);
    expect(db.chunkCount()).toBe(1);
    expect(db.fileCount()).toBe(1);
  });

  it("returns stored mtime for a file", () => {
    const embedding = new Float32Array(768).fill(0);
    db.insertChunks([
      {
        filePath: "/test/bar.ts",
        chunkText: "const x = 1;",
        startLine: 1,
        endLine: 1,
        fileMtime: 9999,
        embeddingProvider: "lm-studio",
        embedding,
      },
    ]);
    expect(db.getFileMtime("/test/bar.ts")).toBe(9999);
    expect(db.getFileMtime("/nonexistent.ts")).toBeNull();
  });

  it("deletes chunks for a file", () => {
    const embedding = new Float32Array(768).fill(0);
    db.insertChunks([
      {
        filePath: "/test/del.ts",
        chunkText: "hello",
        startLine: 1,
        endLine: 1,
        fileMtime: 1,
        embeddingProvider: "lm-studio",
        embedding,
      },
    ]);
    expect(db.chunkCount()).toBe(1);
    db.deleteFile("/test/del.ts");
    expect(db.chunkCount()).toBe(0);
  });

  it("cosine search returns highest similarity first", () => {
    // Insert two chunks: one aligned with query, one orthogonal
    const dim = 4;
    const aligned = new Float32Array([1, 0, 0, 0]);
    const orthogonal = new Float32Array([0, 1, 0, 0]);

    db.insertChunks([
      {
        filePath: "/a.ts",
        chunkText: "aligned",
        startLine: 1,
        endLine: 1,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding: aligned,
      },
      {
        filePath: "/b.ts",
        chunkText: "orthogonal",
        startLine: 1,
        endLine: 1,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding: orthogonal,
      },
    ]);

    const query = new Float32Array([1, 0, 0, 0]);
    const results = db.search(query, 2);
    expect(results[0].chunkText).toBe("aligned");
    expect(results[0].score).toBeCloseTo(1.0, 3);
    expect(results[1].score).toBeCloseTo(0.0, 3);
  });

  it("FTS5 fallback returns results for keyword match", () => {
    const embedding = new Float32Array(4).fill(0);
    db.insertChunks([
      {
        filePath: "/x.ts",
        chunkText: "authenticate user with JWT token",
        startLine: 1,
        endLine: 1,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding,
      },
      {
        filePath: "/y.ts",
        chunkText: "calculate fibonacci sequence",
        startLine: 1,
        endLine: 1,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding,
      },
    ]);

    const results = db.searchFts("JWT token", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunkText).toContain("JWT");
  });
});
