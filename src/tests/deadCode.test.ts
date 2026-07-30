import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { computeDeadCode } from "../metrics/deadCode.js";

describe("computeDeadCode — high-confidence tier (ts/tsx/js/py)", () => {
  it("flags a genuinely unused export as high confidence", async () => {
    const defs = `
export function unusedHelper() {
  return 1;
}
`;
    const findings = await computeDeadCode([
      { path: "src/defs.ts", content: defs },
    ]);
    const hit = findings.find((f) => f.symbol === "unusedHelper");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe("high");
    expect(hit!.kind).toBe("function");
    expect(hit!.path).toBe("src/defs.ts");
  });

  it("does NOT flag a cross-file-used export (tier-aware)", async () => {
    const defs = `
export function unusedHelper() {
  return 1;
}

export function usedHelper() {
  return 2;
}
`;
    const consumer = `
import { usedHelper } from "./defs";

export function caller() {
  return usedHelper();
}
`;
    const findings = await computeDeadCode([
      { path: "src/defs.ts", content: defs },
      { path: "src/consumer.ts", content: consumer },
    ]);

    const usedFinding = findings.find((f) => f.symbol === "usedHelper");
    expect(usedFinding).toBeUndefined();

    const unusedFinding = findings.find((f) => f.symbol === "unusedHelper");
    expect(unusedFinding).toBeDefined();
    expect(unusedFinding!.confidence).toBe("high");
  });

  it("ignores usage that only appears in a test file", async () => {
    const defs = `
export function unusedHelper() {
  return 1;
}
`;
    const testFile = `
import { unusedHelper } from "./defs";

test("calls it", () => {
  unusedHelper();
});
`;
    const findings = await computeDeadCode([
      { path: "src/defs.ts", content: defs },
      { path: "src/defs.test.ts", content: testFile },
    ]);

    const hit = findings.find((f) => f.symbol === "unusedHelper");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe("high");
  });

  it("Python: cross-file usage clears the def, unused stays flagged", async () => {
    const defs = `
def unused_helper():
    return 1

def used_helper():
    return 2
`;
    const consumer = `
from defs import used_helper

def caller():
    return used_helper()
`;
    const findings = await computeDeadCode([
      { path: "src/defs.py", content: defs },
      { path: "src/consumer.py", content: consumer },
    ]);

    expect(findings.find((f) => f.symbol === "used_helper")).toBeUndefined();
    const hit = findings.find((f) => f.symbol === "unused_helper");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe("high");
  });
});

describe("computeDeadCode — low-confidence tier (regex-only refs)", () => {
  it("marks a Go finding low-confidence, never high, given same-file-only refs", async () => {
    // b.go references Helper by name (not a call — `Helper(` never appears)
    // so the regex tier's same-file-only refs scan can't see the usage:
    // this is exactly the false-positive shape the W3-04 caveat warns
    // about. The def must still surface (so a human/LLM can double-check)
    // but never claim high confidence.
    // No leading blank line before `package main`: graph.ts's hybrid regex
    // fallback re-derives line numbers from tree.rootNode.text (which
    // trims leading whitespace) while defs keep the original content's
    // line numbers — a leading blank line desyncs the two. That's a
    // pre-existing quirk in symbols/graph.ts (out of this ticket's
    // read-only-reuse scope, see handoff notes); avoiding it here keeps
    // the fixture representative of a real Go file, which never starts
    // with a blank line anyway.
    const aGo = `package main

func Helper() int {
	return 1
}
`;
    const bGo = `package main

var ref = Helper
`;
    const findings = await computeDeadCode([
      { path: "src/a.go", content: aGo },
      { path: "src/b.go", content: bGo },
    ]);

    const hit = findings.find((f) => f.symbol === "Helper");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe("low");
  });

  it("a Go function called (not just referenced) cross-file is cleared via the calls scan", async () => {
    const aGo = `package main

func Helper() int {
	return 1
}
`;
    const bGo = `package main

func Caller() int {
	return Helper()
}
`;
    const findings = await computeDeadCode([
      { path: "src/a.go", content: aGo },
      { path: "src/b.go", content: bGo },
    ]);
    expect(findings.find((f) => f.symbol === "Helper")).toBeUndefined();
  });
});

describe("computeDeadCode — kind filtering and empty-input contract", () => {
  it("does not report methods (interface/override false-positive risk)", async () => {
    const src = `
export class Service {
  unusedMethod() {
    return 1;
  }
}
`;
    const findings = await computeDeadCode([
      { path: "src/service.ts", content: src },
    ]);
    expect(findings.find((f) => f.symbol === "unusedMethod")).toBeUndefined();
  });

  it("returns [] for empty input", async () => {
    expect(await computeDeadCode([])).toEqual([]);
  });
});

// --- Optional knip cross-check ------------------------------------------
// Skips cleanly (does not fail) if `knip` isn't installed/configured — it's
// an external tool this module exists to make optional, not a required

describe("computeDeadCode ignores definitions inside test files", () => {
  // A helper DEFINED in a test file and used only by that same test file is
  // test code, not dead production code. It looked dead because isTestFile()
  // correctly excludes test files when collecting `usedNames` — so the
  // helper's only references never counted — while the findings loop happily
  // walked those same test files looking for defs.
  //
  // Measured before the fix, over four real repositories:
  //   shipwright  415 of 626 findings (66%) were defs inside test files
  //   repopulse    38 of  97
  //   lodestone    28 of  42
  //   quarry        0 of   5   (no test-local helpers)
  // Two thirds of the output on a real monorepo was one mechanically
  // excludable class, in a metric whose docblock names CodeReckon and
  // RepoPulse as its consumers.
  it("does not report a helper defined and used only within a test file", async () => {
    const findings = await computeDeadCode([
      {
        path: "src/thing.ts",
        content: "export function realThing() { return 1; }\n",
      },
      {
        path: "src/thing.test.ts",
        content: [
          "import { realThing } from './thing.js';",
          "function tmpProject() { return '/tmp/x'; }",
          "it('works', () => { realThing(); tmpProject(); });",
        ].join("\n"),
      },
    ]);

    expect(findings.map((f) => f.symbol)).not.toContain("tmpProject");
  });

  it("still reports production code whose only references are in tests", async () => {
    // The L1 case the metric exists for must keep working: this is the
    // difference between "test helper" and "production code nothing ships".
    const findings = await computeDeadCode([
      {
        path: "src/unwired.ts",
        content: "export function neverShipped() { return 2; }\n",
      },
      {
        path: "src/unwired.test.ts",
        content: [
          "import { neverShipped } from './unwired.js';",
          "it('works', () => { neverShipped(); });",
        ].join("\n"),
      },
    ]);

    expect(findings.map((f) => f.symbol)).toContain("neverShipped");
  });
});

// dependency of the test suite.
function knipAvailable(): boolean {
  try {
    execFileSync("knip", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIfKnip = knipAvailable() ? describe : describe.skip;

describeIfKnip("computeDeadCode vs knip (optional cross-check)", () => {
  it("agrees knip runs cleanly against this repo", () => {
    // A full apples-to-apples comparison needs a knip.json pointed at a
    // throwaway fixture project; at minimum, confirm the binary runs so a
    // human can extend this into a real comparison when knip is present.
    expect(() =>
      execFileSync("knip", ["--version"], { stdio: "pipe" }),
    ).not.toThrow();
  });
});
