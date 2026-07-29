import { describe, it, expect } from "vitest";
import { computeDependencyCycles } from "../metrics/dependencyCycles.js";

describe("computeDependencyCycles", () => {
  it("finds a direct two-file cycle (a -> b -> a)", async () => {
    const a = `import { b } from "./b";\nexport function a() { return b(); }\n`;
    const b = `import { a } from "./a";\nexport function b() { return 1; }\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
      { path: "src/b.ts", content: b },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].length).toBe(2);
    expect(findings[0].cycle[0]).toBe(findings[0].cycle[2]);
    expect(new Set(findings[0].component)).toEqual(
      new Set(["src/a.ts", "src/b.ts"]),
    );
  });

  it("finds a three-file cycle (a -> b -> c -> a) as one concrete chain", async () => {
    const a = `import { b } from "./b";\nexport function a() { return b(); }\n`;
    const b = `import { c } from "./c";\nexport function b() { return c(); }\n`;
    const c = `import { a } from "./a";\nexport function c() { return 1; }\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
      { path: "src/b.ts", content: b },
      { path: "src/c.ts", content: c },
    ]);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.length).toBe(3);
    expect(f.cycle[0]).toBe(f.cycle[3]);
    expect(new Set(f.cycle.slice(0, 3))).toEqual(
      new Set(["src/a.ts", "src/b.ts", "src/c.ts"]),
    );
  });

  it("does NOT flag a plain acyclic chain (a -> b -> c)", async () => {
    const a = `import { b } from "./b";\nexport function a() { return b(); }\n`;
    const b = `import { c } from "./c";\nexport function b() { return c(); }\n`;
    const c = `export function c() { return 1; }\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
      { path: "src/b.ts", content: b },
      { path: "src/c.ts", content: c },
    ]);
    expect(findings).toEqual([]);
  });

  it("detects a self-import as a length-1 cycle", async () => {
    const a = `import { helper } from "./a";\nexport function helper() { return 1; }\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].length).toBe(1);
    expect(findings[0].cycle).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("does not resolve a bare/external specifier into a cycle edge", async () => {
    // b imports a real internal path AND an external package that happens
    // to be named like a's basename — must not be misresolved as a cycle.
    const a = `import { lib } from "b";\nexport function a() { return lib; }\n`;
    const b = `export const lib = 1;\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
      { path: "src/b.ts", content: b },
    ]);
    expect(findings).toEqual([]);
  });

  it("resolves a NodeNext-style '.js' specifier against the real '.ts' file", async () => {
    const a = `import { b } from "./b.js";\nexport function a() { return b(); }\n`;
    const b = `import { a } from "./a.js";\nexport function b() { return 1; }\n`;
    const findings = await computeDependencyCycles([
      { path: "src/a.ts", content: a },
      { path: "src/b.ts", content: b },
    ]);
    expect(findings).toHaveLength(1);
  });

  it("returns [] for empty input", async () => {
    expect(await computeDependencyCycles([])).toEqual([]);
  });
});
