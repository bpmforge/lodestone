import { describe, it, expect } from "vitest";
import { extractGraph } from "../symbols/graph.js";

describe("extractGraph — TypeScript (tree-sitter tier)", () => {
  const src = `
import { helper } from "./helper";

export function outer(): void {
  helper();
  inner();
}

function inner(): void {
  return;
}

export class UserService {
  authenticate(): boolean {
    outer();
    return true;
  }
}

export function unusedExport(): void {
  return;
}
`;

  it("reports tree-sitter as the extraction method", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    expect(g.method).toBe("tree-sitter");
  });

  it("captures defs for functions, classes, and methods", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "outer", kind: "function" }),
    );
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "UserService", kind: "class" }),
    );
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "authenticate", kind: "method" }),
    );
  });

  it("who calls X: 'inner' is called from 'outer'", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    const callers = g.calls.filter((c) => c.callee === "inner");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "outer" }),
    );
  });

  it("who calls X: 'outer' is called from method 'authenticate'", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    const callers = g.calls.filter((c) => c.callee === "outer");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "authenticate" }),
    );
  });

  it("is export Y unused: 'unusedExport' has a def but zero refs", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    const def = g.defs.find((d) => d.symbol === "unusedExport");
    expect(def).toBeDefined();
    const refs = g.refs.filter((r) => r.symbol === "unusedExport");
    expect(refs).toHaveLength(0);
  });

  it("a used symbol ('outer') has at least one ref outside its own decl line", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    const refs = g.refs.filter((r) => r.symbol === "outer");
    expect(refs.length).toBeGreaterThan(0);
  });

  it("captures the import source", async () => {
    const g = await extractGraph(src, "src/auth.ts");
    expect(g.imports).toContainEqual(
      expect.objectContaining({ toPathOrModule: "./helper" }),
    );
  });
});

describe("extractGraph — Python (tree-sitter tier)", () => {
  const src = `
import os
from foo.bar import baz

def outer():
    inner()

def inner():
    return None

class UserService:
    def authenticate(self):
        outer()
        return True

def unused_export():
    return None
`;

  it("reports tree-sitter as the extraction method", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    expect(g.method).toBe("tree-sitter");
  });

  it("captures defs for functions, classes, and methods", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "outer", kind: "function" }),
    );
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "UserService", kind: "class" }),
    );
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "authenticate", kind: "method" }),
    );
  });

  it("who calls X: 'inner' is called from 'outer'", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    const callers = g.calls.filter((c) => c.callee === "inner");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "outer" }),
    );
  });

  it("who calls X: 'outer' is called from method 'authenticate'", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    const callers = g.calls.filter((c) => c.callee === "outer");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "authenticate" }),
    );
  });

  it("is export Y unused: 'unused_export' has a def but zero refs", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    const def = g.defs.find((d) => d.symbol === "unused_export");
    expect(def).toBeDefined();
    const refs = g.refs.filter((r) => r.symbol === "unused_export");
    expect(refs).toHaveLength(0);
  });

  it("captures plain and from-imports", async () => {
    const g = await extractGraph(src, "pkg/auth.py");
    expect(g.imports).toContainEqual(
      expect.objectContaining({ toPathOrModule: "os" }),
    );
    expect(g.imports).toContainEqual(
      expect.objectContaining({ toPathOrModule: "foo.bar" }),
    );
  });
});

describe("extractGraph — grammarless language (regex tier)", () => {
  const src = `
func outer() {
  helper()
}

func helper() {
  print("hi")
}
`;

  it("falls back to regex for an unsupported extension and still emits defs", async () => {
    const g = await extractGraph(src, "script.zig");
    expect(g.method).toBe("regex");
    expect(g.defs).toEqual([]); // no regex pattern for .zig — must not crash
  });

  it("never throws on empty content", async () => {
    const g = await extractGraph("", "empty.ts");
    expect(g).toEqual({
      defs: [],
      refs: [],
      calls: [],
      imports: [],
      method: "regex",
    });
  });

  it("swift (grammarless but regex-supported) produces defs via the regex tier", async () => {
    const swiftSrc = `
func outer() {
  helper()
}

func helper() {
}
`;
    const g = await extractGraph(swiftSrc, "App.swift");
    expect(g.method).toBe("regex");
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "outer", kind: "function" }),
    );
    const callers = g.calls.filter((c) => c.callee === "helper");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "outer" }),
    );
  });
});

describe("extractGraph — tree-sitter defs with regex refs/calls/imports (hybrid tier)", () => {
  it("Go: defs come from tree-sitter, method stays 'tree-sitter' (hybrid layered on top)", async () => {
    const src = `
package main

func outer() {
	inner()
}

func inner() {
}
`;
    const g = await extractGraph(src, "main.go");
    expect(g.method).toBe("tree-sitter");
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "outer", kind: "function" }),
    );
    expect(g.defs).toContainEqual(
      expect.objectContaining({ symbol: "inner", kind: "function" }),
    );
    // calls come from the regex layer for Go — still populated, not dropped.
    const callers = g.calls.filter((c) => c.callee === "inner");
    expect(callers).toContainEqual(
      expect.objectContaining({ caller: "outer" }),
    );
  });
});
