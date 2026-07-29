import { describe, it, expect } from "vitest";
import { computeUntestedSurface } from "../metrics/untestedSurface.js";

describe("computeUntestedSurface", () => {
  it("flags an exported function with no test-file reference", async () => {
    const src = `
export function chargeCard(amount: number) {
  return amount;
}
`;
    const findings = await computeUntestedSurface([
      { path: "src/billing.ts", content: src },
    ]);
    const hit = findings.find((f) => f.symbol === "chargeCard");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("function");
    expect(hit!.path).toBe("src/billing.ts");
    expect(hit!.reason).toContain("chargeCard");
  });

  it("does NOT flag an exported function referenced by name in a test file", async () => {
    const src = `
export function chargeCard(amount: number) {
  return amount;
}
`;
    const test = `
import { chargeCard } from "./billing";

test("charges", () => {
  chargeCard(5);
});
`;
    const findings = await computeUntestedSurface([
      { path: "src/billing.ts", content: src },
      { path: "src/billing.test.ts", content: test },
    ]);
    expect(findings.find((f) => f.symbol === "chargeCard")).toBeUndefined();
  });

  it("does NOT flag an exported class referenced (not called) in a test file", async () => {
    const src = `
export class Widget {
  render() {
    return 1;
  }
}
`;
    const test = `
import { Widget } from "./widget";

test("constructs", () => {
  const w = new Widget();
  expect(w).toBeDefined();
});
`;
    const findings = await computeUntestedSurface([
      { path: "src/widget.ts", content: src },
      { path: "src/widget.test.ts", content: test },
    ]);
    expect(findings.find((f) => f.symbol === "Widget")).toBeUndefined();
  });

  it("does not flag a non-exported function (no `export` keyword)", async () => {
    const src = `
function internalHelper() {
  return 1;
}
`;
    const findings = await computeUntestedSurface([
      { path: "src/util.ts", content: src },
    ]);
    expect(findings.find((f) => f.symbol === "internalHelper")).toBeUndefined();
  });

  it("does not flag a method (kind filtering — interface/override risk)", async () => {
    const src = `
export class Service {
  handle() {
    return 1;
  }
}
`;
    const test = `
import { Service } from "./service";
test("constructs", () => {
  new Service();
});
`;
    const findings = await computeUntestedSurface([
      { path: "src/service.ts", content: src },
      { path: "src/service.test.ts", content: test },
    ]);
    // Service (class) is cleared by the test; its method "handle" must
    // never appear as its own finding regardless.
    expect(findings.find((f) => f.symbol === "handle")).toBeUndefined();
  });

  it("does not scan Python files (documented language-scope boundary)", async () => {
    const src = `
def charge_card(amount):
    return amount
`;
    const findings = await computeUntestedSurface([
      { path: "src/billing.py", content: src },
    ]);
    expect(findings).toEqual([]);
  });

  it("returns [] for empty input", async () => {
    expect(await computeUntestedSurface([])).toEqual([]);
  });

  it("honors a custom isTestFile predicate instead of the default convention", async () => {
    const src = `
export function chargeCard(amount: number) {
  return amount;
}
`;
    // Uses a project convention the default regex would NOT match.
    const qaFile = `
import { chargeCard } from "./billing";
qaCheck("charges", () => chargeCard(5));
`;
    const withoutOption = await computeUntestedSurface([
      { path: "src/billing.ts", content: src },
      { path: "qa/billing.qa.ts", content: qaFile },
    ]);
    expect(withoutOption.find((f) => f.symbol === "chargeCard")).toBeDefined(); // default convention doesn't recognize qa/*.qa.ts as a test file

    const withOption = await computeUntestedSurface(
      [
        { path: "src/billing.ts", content: src },
        { path: "qa/billing.qa.ts", content: qaFile },
      ],
      { isTestFile: (p) => p.startsWith("qa/") },
    );
    expect(withOption.find((f) => f.symbol === "chargeCard")).toBeUndefined();
  });

  it("KNOWN LIMITATION: name collision across files silently clears an untested duplicate name", async () => {
    // Two unrelated exported functions share the name "handle". Only the
    // one in fileB is exercised by a test. Because refs/calls are matched
    // by symbol name only (no path resolution — see module doc), fileA's
    // genuinely untested "handle" is incorrectly cleared too. This test
    // documents the real, demonstrated behavior rather than describing a
    // hypothetical.
    const fileA = `
export function handle(x: number) {
  return x + 1;
}
`;
    const fileB = `
export function handle(x: string) {
  return x.length;
}
`;
    const testB = `
import { handle } from "./b";
test("handles", () => {
  handle("x");
});
`;
    const findings = await computeUntestedSurface([
      { path: "src/a.ts", content: fileA },
      { path: "src/b.ts", content: fileB },
      { path: "src/b.test.ts", content: testB },
    ]);
    // Documents the limitation: fileA's "handle" is NOT flagged, even
    // though it has no test of its own.
    expect(
      findings.find((f) => f.symbol === "handle" && f.path === "src/a.ts"),
    ).toBeUndefined();
  });
});
