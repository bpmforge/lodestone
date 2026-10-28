import { describe, it, expect } from "vitest";
import { extractGraph } from "../symbols/graph.js";

// Tree-sitter call sites for the defs-only grammars. Before this, their calls
// came from the regex tier's `identifier(` scan: on gin that recorded `func`
// (every immediately invoked literal) as a callee and README examples as callers.

async function callees(path: string, src: string): Promise<string[]> {
  const g = await extractGraph(src, path);
  return g.calls.map((c) => `${c.caller}>${c.callee}`).sort();
}

describe("extractGraph — tree-sitter calls beyond ts/js/python", () => {
  it("go: plain, selector and package calls; no name for a func literal", async () => {
    const src =
      "package m\n\nfunc run() {\n\tdefer func() { log(x) }()\n\ts.Serve(1)\n\thttp.ListenAndServe()\n}\n";
    expect(await callees("a.go", src)).toEqual([
      "run>ListenAndServe",
      "run>Serve",
      "run>log",
    ]);
  });

  it("rust: path and method calls, not macros", async () => {
    const src =
      'fn run() {\n    // fake(0)\n    g(1);\n    a.b(2);\n    m::h(3);\n    println!("x");\n}\n';
    expect(await callees("a.rs", src)).toEqual(["run>b", "run>g", "run>h"]);
  });

  it("java: method invocations", async () => {
    const src = "class A {\n  void run() {\n    String s = \"fake(0)\";\n    g(1);\n    a.b(2);\n  }\n}\n";
    expect(await callees("A.java", src)).toEqual(["run>b", "run>g"]);
  });

  it("c and c++: field and qualified calls", async () => {
    expect(
      await callees("a.c", "void run() {\n  /* fake(0) */\n  g(1);\n  p->k(3);\n}\n"),
    ).toEqual(["run>g", "run>k"]);
    expect(
      await callees("a.cpp", "void run() {\n  // fake(0)\n  s.h(2);\n  ns::k(3);\n}\n"),
    ).toEqual(["run>h", "run>k"]);
  });

  it("c#: invocations", async () => {
    const src = "class A {\n  void Run() {\n    // Fake(0)\n    G(1);\n    a.B(2);\n  }\n}\n";
    expect(await callees("A.cs", src)).toEqual(["Run>B", "Run>G"]);
  });

  it("ruby and php: method calls", async () => {
    expect(await callees("a.rb", "def run\n  # fake(0)\n  g(1)\n  a.b(2)\nend\n")).toEqual([
      "run>b",
      "run>g",
    ]);
    expect(
      await callees(
        "a.php",
        "<?php\nfunction run() {\n  // fake(0)\n  g(1);\n  $a->b(2);\n  A::c(3);\n}\n",
      ),
    ).toEqual(["run>b", "run>c", "run>g"]);
  });

  it("keeps the regex tier's imports for these languages", async () => {
    const g = await extractGraph(
      'package m\n\nimport "net/http"\n\nfunc run() { http.Get() }\n',
      "a.go",
    );
    expect(g.imports.map((i) => i.toPathOrModule)).toEqual(["net/http"]);
  });
});

describe("extractGraph — prose", () => {
  it("records no graph for markdown, even with code examples", async () => {
    const g = await extractGraph(
      '# Usage\n\n```go\nrouter.RunUnix("/tmp/s")\n```\n',
      "README.md",
    );
    expect(g.calls).toEqual([]);
    expect(g.refs).toEqual([]);
  });
});
