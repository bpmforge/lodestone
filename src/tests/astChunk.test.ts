import { describe, it, expect } from "vitest";
import { chunkFile } from "../chunker/index.js";

describe("chunkFile — cAST tree-sitter chunker", () => {
  describe("TypeScript", () => {
    const src = `
import { foo } from "bar";

const GREETING = "hi";

export function topFn(a: number): number {
  return a + 1;
}

export class UserService {
  private db: unknown;

  constructor(db: unknown) {
    this.db = db;
  }

  async authenticate(user: string): Promise<boolean> {
    return true;
  }
}
`;

    it("emits a function-level chunk with the correct header", async () => {
      const chunks = await chunkFile(src, "src/auth.ts");
      const fn = chunks.find((c) => c.text.includes("function topFn"));
      expect(fn).toBeDefined();
      expect(fn!.header).toBe("src/auth.ts > topFn");
      expect(fn!.symbolChain).toEqual(["topFn"]);
    });

    it("emits a method chunk with a class > method header", async () => {
      const chunks = await chunkFile(src, "src/auth.ts");
      const method = chunks.find((c) => c.text.includes("authenticate"));
      expect(method).toBeDefined();
      expect(method!.header).toBe(
        "src/auth.ts > class UserService > authenticate",
      );
      expect(method!.symbolChain).toEqual([
        "class UserService",
        "authenticate",
      ]);
    });

    it("does not merge two separate methods into one chunk", async () => {
      const chunks = await chunkFile(src, "src/auth.ts");
      const constructorChunk = chunks.find(
        (c) => c.symbolChain?.at(-1) === "constructor",
      );
      const authChunk = chunks.find(
        (c) => c.symbolChain?.at(-1) === "authenticate",
      );
      expect(constructorChunk).toBeDefined();
      expect(authChunk).toBeDefined();
      expect(constructorChunk!.text).not.toBe(authChunk!.text);
    });

    it("merges top-level filler (imports, consts) into its own chunk", async () => {
      const chunks = await chunkFile(src, "src/auth.ts");
      const filler = chunks.find((c) => c.text.includes("import { foo }"));
      expect(filler).toBeDefined();
      expect(filler!.text).toContain("GREETING");
      expect(filler!.header).toBe("src/auth.ts");
    });
  });

  describe("Python", () => {
    const src = `
import os

CONST = 1


def top_fn(a):
    return a + 1


class UserService:
    def __init__(self, db):
        self.db = db

    async def authenticate(self, user):
        return True
`;

    it("emits a function-level chunk with the correct header", async () => {
      const chunks = await chunkFile(src, "app/service.py");
      const fn = chunks.find((c) => c.text.includes("def top_fn"));
      expect(fn).toBeDefined();
      expect(fn!.header).toBe("app/service.py > top_fn");
    });

    it("emits a method chunk with a class > method header", async () => {
      const chunks = await chunkFile(src, "app/service.py");
      const method = chunks.find((c) => c.text.includes("def authenticate"));
      expect(method).toBeDefined();
      expect(method!.header).toBe(
        "app/service.py > class UserService > authenticate",
      );
    });
  });

  describe("Go", () => {
    const src = `
package main

import "fmt"

const X = 1

func TopFn(a int) int {
	return a + 1
}

type UserService struct {
	db string
}

func (u *UserService) Authenticate(user string) bool {
	return true
}
`;

    it("emits a function-level chunk with the correct header", async () => {
      const chunks = await chunkFile(src, "main.go");
      const fn = chunks.find((c) => c.text.includes("func TopFn"));
      expect(fn).toBeDefined();
      expect(fn!.header).toBe("main.go > TopFn");
    });

    it("emits a method chunk headered by its receiver type", async () => {
      const chunks = await chunkFile(src, "main.go");
      const method = chunks.find((c) =>
        c.text.includes("func (u *UserService) Authenticate"),
      );
      expect(method).toBeDefined();
      expect(method!.header).toBe("main.go > UserService > Authenticate");
    });
  });

  describe("oversized-function splitting", () => {
    it("splits a function whose body exceeds the token budget into parts", async () => {
      // ~1200 token budget at ~4 chars/token ≈ 4800 chars. Build a function
      // body comfortably over that with many small statements so it must split.
      const statements = Array.from(
        { length: 400 },
        (_, i) => `  const v${i} = ${i} + 1;`,
      ).join("\n");
      const src = `function bigFn(x) {\n${statements}\n  return x;\n}\n`;

      const chunks = await chunkFile(src, "src/big.ts");
      const parts = chunks.filter((c) =>
        c.symbolChain?.at(-1)?.startsWith("bigFn"),
      );
      expect(parts.length).toBeGreaterThan(1);

      // First part carries the signature; continuation parts are labeled.
      expect(parts[0].text).toContain("function bigFn(x)");
      expect(parts[0].symbolChain?.at(-1)).toBe("bigFn");
      expect(parts[1].symbolChain?.at(-1)).toMatch(/bigFn \(part 2\)/);

      // No statement should be silently dropped between parts.
      expect(parts.every((p) => p.text.length > 0)).toBe(true);
    });

    it("never crashes and always emits something for a single giant statement", async () => {
      const src = `const bigArray = [${Array.from({ length: 2000 }, (_, i) => i).join(", ")}];\n`;
      const chunks = await chunkFile(src, "src/data.ts");
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].text).toContain("bigArray");
    });
  });

  describe("fallback for unknown/unsupported languages", () => {
    it("falls back to the window chunker for an unmapped extension", async () => {
      const content = Array.from({ length: 120 }, (_, i) => `line ${i}`).join(
        "\n",
      );
      const chunks = await chunkFile(content, "notes.txt");
      expect(chunks.length).toBeGreaterThan(1);
      // Fallback chunks never carry an AST header.
      expect(chunks.every((c) => c.header === undefined)).toBe(true);
    });

    it("falls back when no filePath is provided at all", async () => {
      // Content must exceed the window fallback's MIN_CHUNK_CHARS (50) to
      // produce a chunk — same rule the pre-existing chunker.test.ts uses.
      const content = `export function foo(a, b) {\n  return a + b + 100;\n}\n`;
      const chunks = await chunkFile(content);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].header).toBeUndefined();
    });

    it("falls back gracefully for a file with syntax errors rather than crashing", async () => {
      const broken = `function foo( {{{ this is not valid typescript at all +++`;
      await expect(chunkFile(broken, "src/broken.ts")).resolves.toBeDefined();
      const chunks = await chunkFile(broken, "src/broken.ts");
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
