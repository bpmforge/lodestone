import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";

// The "./graph" entry is for consumers that must not load native addons
// (RepoPulse's worker image builds none). Walk its static import graph and
// fail if anything outside the allowlist is reachable.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED_PACKAGES = new Set(["web-tree-sitter", "path", "module", "fs", "url"]);

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
    // `import type` / `export type` never reach runtime.
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
    out.push(m[1]!);
  }
  return out;
}

describe("graph entry (./graph)", () => {
  it("reaches no native addon or MCP code", () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const todo = [path.join(SRC, "graph.ts")];
    while (todo.length) {
      const file = todo.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".")) todo.push(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
        else packages.add(spec.replace(/^node:/, ""));
      }
    }
    expect([...packages].filter((p) => !ALLOWED_PACKAGES.has(p))).toEqual([]);
    expect([...seen].map((f) => path.relative(SRC, f)).sort()).not.toContain("db.ts");
  });

  it("extracts a graph through the entry", async () => {
    const { extractGraph, isCrossFileGraphReliable } = await import("../graph.js");
    const g = await extractGraph("export function a() { return b(); }\nfunction b() { return 1; }\n", "x.ts");
    expect(g.method).toBe("tree-sitter");
    expect(g.defs.map((d) => d.symbol).sort()).toEqual(["a", "b"]);
    expect(g.calls).toContainEqual(expect.objectContaining({ caller: "a", callee: "b", line: 1 }));
    expect(isCrossFileGraphReliable("x.ts")).toBe(true);
    expect(isCrossFileGraphReliable("x.go")).toBe(false);
  });
});
