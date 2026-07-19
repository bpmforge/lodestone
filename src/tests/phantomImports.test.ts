import { describe, it, expect } from "vitest";
import { computePhantomImports } from "../metrics/phantomImports.js";

describe("computePhantomImports — R-25 phantom imports", () => {
  it("flags a named import never referenced in the file", async () => {
    const src = `
import { something } from "nonexistent-package";

export function run() {
  return 1;
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    const hit = findings.find((f) => f.symbol === "something");
    expect(hit).toBeDefined();
    expect(hit!.rule).toBe("R-25");
    expect(hit!.module).toBe("nonexistent-package");
  });

  it("does NOT flag a named import that is used (clean case)", async () => {
    const src = `
import { helper } from "./util";

export function run() {
  return helper();
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "helper")).toBeUndefined();
  });

  it("flags an unused default import and clears a used one in the same statement", async () => {
    const src = `
import Default, { used, unused } from "./mixed";

export function run() {
  return used();
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "Default")).toBeDefined();
    expect(findings.find((f) => f.symbol === "unused")).toBeDefined();
    expect(findings.find((f) => f.symbol === "used")).toBeUndefined();
  });

  it("flags an unused namespace import", async () => {
    const src = `
import * as fs from "fs";

export function run() {
  return 1;
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "fs")).toBeDefined();
  });

  it("does not misflag an inline `type` qualifier on a used named import", async () => {
    // Regression case: `import { type Foo }` must bind the name "Foo",
    // not the literal string "type Foo" (which could never match a real
    // `Foo` usage and would always look unused).
    const src = `
import { type Foo, bar } from "./types";

export function run(x: Foo) {
  return bar();
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    expect(findings).toEqual([]);
  });

  it("does not flag a side-effect-only import (no bound name)", async () => {
    const src = `
import "./polyfill";

export function run() {
  return 1;
}
`;
    const findings = computePhantomImports([
      { path: "src/x.ts", content: src },
    ]);

    expect(findings).toEqual([]);
  });

  it("Python: flags an unused `import requests`", async () => {
    const src = `
import requests


def run():
    return 1
`;
    const findings = computePhantomImports([
      { path: "src/x.py", content: src },
    ]);

    const hit = findings.find((f) => f.symbol === "requests");
    expect(hit).toBeDefined();
    expect(hit!.module).toBe("requests");
  });

  it("Python: does NOT flag a used `from x import a, b` (clean case)", async () => {
    const src = `
from utils import helper_a, helper_b


def run():
    return helper_a() + helper_b()
`;
    const findings = computePhantomImports([
      { path: "src/x.py", content: src },
    ]);

    expect(findings).toEqual([]);
  });

  it("Python: does not flag a wildcard import", async () => {
    const src = `
from utils import *


def run():
    return 1
`;
    const findings = computePhantomImports([
      { path: "src/x.py", content: src },
    ]);

    expect(findings).toEqual([]);
  });

  it("returns [] for empty input", () => {
    expect(computePhantomImports([])).toEqual([]);
  });
});
