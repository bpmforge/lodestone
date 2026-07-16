import { describe, it, expect } from "vitest";
import { extractRefLines, formatRefLines, snippet } from "../format.js";
import type { SearchResult } from "../db.js";

function mkChunk(
  filePath: string,
  startLine: number,
  text: string,
): SearchResult {
  return {
    id: 1,
    filePath,
    chunkText: text,
    startLine,
    endLine: startLine + text.split("\n").length - 1,
    fileMtime: 0,
    embeddingProvider: "x",
    score: 1,
  };
}

describe("extractRefLines", () => {
  it("extracts the referencing line (absolute line#) with context, not the whole chunk", () => {
    const chunk = mkChunk(
      "src/a.ts",
      10,
      ["const x = 1;", "foo(bar);", "const y = 2;"].join("\n"),
    );
    const { refs } = extractRefLines([chunk], "foo", new Set());
    expect(refs.length).toBe(1);
    expect(refs[0]!.line).toBe(11); // startLine 10 + offset 1
    expect(refs[0]!.isDef).toBe(false);
    expect(refs[0]!.context).toContain("11 > foo(bar);"); // ref line marked
    expect(refs[0]!.context).toContain("   10"); // ±context above
    expect(refs[0]!.context).toContain("   12"); // ±context below
  });

  it("tags a line as [def] when it matches a symbol-definition key", () => {
    const chunk = mkChunk("src/a.ts", 5, "function foo() {}");
    const { refs } = extractRefLines([chunk], "foo", new Set(["src/a.ts:5"]));
    expect(refs[0]!.isDef).toBe(true);
    expect(formatRefLines("foo", refs, false)).toContain("[def]");
    expect(formatRefLines("foo", refs, false)).toContain("1 definition(s)");
  });

  it("word-boundary: a substring like fooBar is NOT a reference to foo", () => {
    const chunk = mkChunk("src/a.ts", 1, "fooBar();");
    const { refs } = extractRefLines([chunk], "foo", new Set());
    expect(refs.length).toBe(0);
  });

  it("de-dups the same physical line surfaced by overlapping chunks", () => {
    const c1 = mkChunk("src/a.ts", 10, "foo();");
    const c2 = mkChunk("src/a.ts", 10, "foo();");
    const { refs } = extractRefLines([c1, c2], "foo", new Set());
    expect(refs.length).toBe(1);
  });

  it("truncates at maxRefs and flags it", () => {
    const chunk = mkChunk("src/a.ts", 1, ["foo", "foo", "foo"].join("\n"));
    const { refs, truncated } = extractRefLines([chunk], "foo", new Set(), {
      maxRefs: 2,
    });
    expect(refs.length).toBe(2);
    expect(truncated).toBe(true);
    expect(formatRefLines("foo", refs, truncated)).toContain("truncated");
  });

  it("empty result renders a helpful message, not a crash", () => {
    expect(formatRefLines("foo", [], false)).toContain("No references found");
  });
});

describe("snippet", () => {
  it("caps long chunks and notes elision", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const s = snippet(text, 10);
    expect(s.split("\n").length).toBeLessThan(40);
    expect(s).toContain("more line(s)");
  });

  it("passes short chunks through unchanged", () => {
    expect(snippet("a\nb\nc", 10)).toBe("a\nb\nc");
  });
});
