import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodeSearchDb } from "../db.js";
import os from "os";
import path from "path";
import fs from "fs";

function tempDb(): { db: CodeSearchDb; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-search-bm25f-"));
  const db = new CodeSearchDb(path.join(dir, "index.db"));
  return {
    db,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true });
    },
  };
}

describe("BM25F weighted FTS (symbols / subtokens / body)", () => {
  let db: CodeSearchDb;
  let cleanup: () => void;

  beforeEach(() => ({ db, cleanup } = tempDb()));
  afterEach(() => cleanup());

  it(
    "matches a natural-language query to a symbol via subtoken splitting " +
      "— no embedding model involved",
    () => {
      const embedding = new Float32Array(4).fill(0);
      db.insertChunks([
        {
          filePath: "/auth/validate.ts",
          chunkText:
            "export function validateUserPassword(pw: string): boolean {\n  return pw.length > 8;\n}",
          startLine: 1,
          endLine: 3,
          fileMtime: 1,
          embeddingProvider: "test",
          embedding,
          symbols: ["validateUserPassword"],
        },
        {
          filePath: "/math/fib.ts",
          chunkText:
            "export function fibonacci(n: number): number {\n  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);\n}",
          startLine: 1,
          endLine: 3,
          fileMtime: 1,
          embeddingProvider: "test",
          embedding,
          symbols: ["fibonacci"],
        },
      ]);

      // Pure lexical query — searchFts never touches an embedder. The query
      // uses "validation" (a noun) while the indexed symbol subtoken is
      // "validate" (a verb); the porter stemmer folds both to the same
      // root, so this only matches via the subtokens column, not a literal
      // substring match against chunk_text.
      const results = db.searchFts("password validation", 5);
      expect(results.length).toBe(1);
      expect(results[0]!.filePath).toBe("/auth/validate.ts");
    },
  );

  it("ranks a symbol-column hit above a body-only hit for the same term", () => {
    const embedding = new Float32Array(4).fill(0);
    db.insertChunks([
      {
        filePath: "/auth/token.ts",
        chunkText: "export function credential(): string {\n  return x;\n}",
        startLine: 1,
        endLine: 2,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding,
        symbols: ["credential"],
      },
      {
        filePath: "/notes/todo.ts",
        chunkText:
          "// TODO: eventually handle credential rotation here, low priority\nexport function placeholder(): void {}",
        startLine: 1,
        endLine: 2,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding,
        // no symbols — "credential" only appears in the comment (body)
      },
    ]);

    const results = db.searchFts("credential", 5);
    expect(results.length).toBe(2);
    expect(results[0]!.filePath).toBe("/auth/token.ts"); // symbol column wins
    expect(results[1]!.filePath).toBe("/notes/todo.ts"); // body-only, ranks lower
  });

  it("searchFtsForName (code_references) also applies the weighted columns", () => {
    const embedding = new Float32Array(4).fill(0);
    db.insertChunks([
      {
        filePath: "/svc/user.ts",
        chunkText: "export class UserRepository {\n  find() {}\n}",
        startLine: 1,
        endLine: 2,
        fileMtime: 1,
        embeddingProvider: "test",
        embedding,
        symbols: ["UserRepository"],
      },
    ]);

    const results = db.searchFtsForName("UserRepository", 5);
    expect(results.length).toBe(1);
    expect(results[0]!.filePath).toBe("/svc/user.ts");
  });
});
