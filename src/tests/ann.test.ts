import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodeSearchDb } from "../db.js";
import os from "os";
import path from "path";
import fs from "fs";

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-search-ann-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true });
    },
  };
}

function chunk(filePath: string, text: string, emb: number[]) {
  return {
    filePath,
    chunkText: text,
    startLine: 1,
    endLine: 1,
    fileMtime: 1000,
    embeddingProvider: "lm-studio",
    embedding: new Float32Array(emb),
  };
}

describe("ANN (sqlite-vec) vector search", () => {
  let db: CodeSearchDb;
  let cleanup: () => void;
  beforeEach(() => ({ db, cleanup } = tempDb()));
  afterEach(() => cleanup());

  it("loads the sqlite-vec extension", () => {
    expect(db.annEnabled).toBe(true);
  });

  it("returns the nearest chunk first with a cosine-similarity score", () => {
    db.insertChunks([
      chunk("a.ts", "alpha", [1, 0, 0]),
      chunk("b.ts", "beta", [0, 1, 0]),
      chunk("c.ts", "gamma", [0.9, 0.1, 0]),
    ]);
    const res = db.search(new Float32Array([1, 0, 0]), 3);
    expect(res.length).toBe(3);
    expect(res[0]!.filePath).toBe("a.ts"); // exact match ranks first
    expect(res[0]!.score).toBeCloseTo(1, 2); // cosine similarity ≈ 1
    expect(res[1]!.filePath).toBe("c.ts"); // next closest
    expect(res[2]!.filePath).toBe("b.ts"); // orthogonal, last
  });

  it("drops ANN rows when a file is deleted (re-index safety)", () => {
    db.insertChunks([
      chunk("a.ts", "alpha", [1, 0, 0]),
      chunk("b.ts", "beta", [0, 1, 0]),
    ]);
    db.deleteFile("a.ts");
    const res = db.search(new Float32Array([1, 0, 0]), 5);
    expect(res.find((r) => r.filePath === "a.ts")).toBeUndefined();
    expect(res.length).toBe(1);
  });

  it("ANN ranking agrees with the brute-force scan", () => {
    db.insertChunks([
      chunk("a.ts", "a", [1, 0, 0]),
      chunk("b.ts", "b", [0, 1, 0]),
      chunk("c.ts", "c", [0.8, 0.2, 0]),
    ]);
    const q = new Float32Array([1, 0, 0]);
    const ann = db.search(q, 3).map((r) => r.filePath);
    const brute = db.searchBrute(q, 3).map((r) => r.filePath);
    expect(ann).toEqual(brute);
  });
});
