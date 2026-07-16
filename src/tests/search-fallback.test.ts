import { describe, it, expect } from "vitest";
import { search, rrfFuse, toFtsQuery } from "../search.js";
import type { SearchResult } from "../db.js";

function mk(id: number, filePath: string): SearchResult {
  return {
    id,
    filePath,
    chunkText: `chunk ${id}`,
    startLine: 1,
    endLine: 1,
    fileMtime: 0,
    embeddingProvider: "x",
    score: 1,
  };
}

describe("toFtsQuery (FTS5-safe)", () => {
  it("quotes word terms and ORs them (natural-language query can't break MATCH)", () => {
    expect(toFtsQuery("how does auth work?")).toBe(
      '"how" OR "does" OR "auth" OR "work"',
    );
  });
  it("returns empty for punctuation-only input", () => {
    expect(toFtsQuery("?!.")).toBe("");
  });
});

describe("rrfFuse", () => {
  it("ranks a chunk that appears in BOTH lists above one in only a single list", () => {
    const vec = [mk(1, "a"), mk(2, "b")];
    const fts = [mk(2, "b"), mk(3, "c")];
    const fused = rrfFuse([vec, fts], 10);
    // id 2 appears in both → highest fused score → first
    expect(fused[0]!.id).toBe(2);
    expect(fused.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });
  it("de-dups by chunk id", () => {
    const fused = rrfFuse([[mk(1, "a")], [mk(1, "a")]], 10);
    expect(fused.length).toBe(1);
  });
});

describe("search() degradation", () => {
  const sentinel = [mk(9, "fts.ts")];

  it("falls back to keyword-only when the provider embed throws (provider died)", async () => {
    const db: any = {
      getProviderMeta: () => ({ name: "lm-studio", dim: 768 }),
      searchFts: () => sentinel,
      search: () => {
        throw new Error("vector path must not run after an embed failure");
      },
    };
    const provider: any = {
      name: "lm-studio",
      dim: 768,
      embed: async () => {
        throw new Error("provider down");
      },
    };
    const res = await search("some query", db, provider, {});
    expect(res).toEqual(sentinel);
  });

  it("uses keyword-only when no index/meta exists yet", async () => {
    const db: any = {
      getProviderMeta: () => null,
      searchFts: () => sentinel,
      search: () => {
        throw new Error("vector path must not run without meta");
      },
    };
    const res = await search("q", db, null, {});
    expect(res).toEqual(sentinel);
  });

  it("fuses both sides when the provider works", async () => {
    const vec = [mk(1, "a.ts"), mk(2, "b.ts")];
    const fts = [mk(2, "b.ts"), mk(3, "c.ts")];
    const db: any = {
      getProviderMeta: () => ({ name: "lm-studio", dim: 768 }),
      searchFts: () => fts,
      search: () => vec,
    };
    const provider: any = {
      name: "lm-studio",
      dim: 768,
      embed: async () => [[0.1, 0.2, 0.3]],
    };
    const res = await search("q", db, provider, {});
    expect(res[0]!.id).toBe(2); // in both lists → top
    expect(res.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });
});
