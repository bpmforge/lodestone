import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import {
  computeComplexity,
  SUPPORTED_LANGUAGES,
} from "../metrics/complexity.js";

describe("computeComplexity — fallback contract", () => {
  it("returns [] for blank content", async () => {
    expect(await computeComplexity("", "src/x.ts")).toEqual([]);
    expect(await computeComplexity("   \n  ", "src/x.ts")).toEqual([]);
  });

  it("returns [] for a grammarless extension instead of throwing", async () => {
    const result = await computeComplexity(
      "# just some markdown\n\nsome text",
      "README.md",
    );
    expect(result).toEqual([]);
  });

  it("returns [] for a language with a chunker grammar but no complexity config", async () => {
    // Rust has a wired tree-sitter grammar (chunker/adapters.ts) but no
    // COMPLEXITY_CONFIGS entry yet — must skip, not crash.
    const result = await computeComplexity(
      "fn foo() -> i32 { 1 }",
      "src/lib.rs",
    );
    expect(result).toEqual([]);
  });

  it("advertises the languages it scores", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(
      expect.arrayContaining([
        "typescript",
        "tsx",
        "javascript",
        "python",
        "go",
      ]),
    );
  });
});

describe("computeComplexity — TypeScript", () => {
  it("a straight-line function is cyclomatic 1, cognitive 0", async () => {
    const src = `
export function add(a: number, b: number): number {
  return a + b;
}
`;
    const [fn] = await computeComplexity(src, "src/add.ts");
    expect(fn.name).toBe("add");
    expect(fn.path).toBe("src/add.ts");
    expect(fn.line).toBe(2);
    expect(fn.cyclomatic).toBe(1);
    expect(fn.cognitive).toBe(0);
  });

  it("N independent if-branches raise cyclomatic to N+1", async () => {
    const src = `
function classify(x: number): string {
  if (x === 1) return "one";
  if (x === 2) return "two";
  if (x === 3) return "three";
  return "other";
}
`;
    const [fn] = await computeComplexity(src, "src/classify.ts");
    expect(fn.cyclomatic).toBe(4); // 1 base + 3 ifs
  });

  it("logical && / || each add one decision point", async () => {
    const src = `
function guard(a: boolean, b: boolean, c: boolean): boolean {
  return a && b || c;
}
`;
    const [fn] = await computeComplexity(src, "src/guard.ts");
    expect(fn.cyclomatic).toBe(3); // 1 base + && + ||
  });

  it("a ternary and a catch each count as a decision point", async () => {
    const src = `
function risky(a: number): number {
  try {
    return a > 0 ? a : -a;
  } catch (e) {
    return 0;
  }
}
`;
    const [fn] = await computeComplexity(src, "src/risky.ts");
    expect(fn.cyclomatic).toBe(3); // 1 base + ternary + catch
  });

  it("nesting raises cognitive complexity relative to flat branches", async () => {
    const flat = `
function flat(a: boolean, b: boolean): number {
  if (a) return 1;
  if (b) return 2;
  return 0;
}
`;
    const nested = `
function nested(a: boolean, b: boolean): number {
  if (a) {
    if (b) {
      return 1;
    }
  }
  return 0;
}
`;
    const [flatFn] = await computeComplexity(flat, "src/flat.ts");
    const [nestedFn] = await computeComplexity(nested, "src/nested.ts");

    // Same cyclomatic (2 decision points each)...
    expect(flatFn.cyclomatic).toBe(3);
    expect(nestedFn.cyclomatic).toBe(3);
    // ...but nesting must cost more cognitively: flat = 1+1=2, nested = 1+2=3.
    expect(nestedFn.cognitive).toBeGreaterThan(flatFn.cognitive);
    expect(flatFn.cognitive).toBe(2);
    expect(nestedFn.cognitive).toBe(3);
  });

  it("reports class > method chains and per-function lines", async () => {
    const src = `
export class UserService {
  async authenticate(user: string): Promise<boolean> {
    if (!user) return false;
    return true;
  }
}
`;
    const results = await computeComplexity(src, "src/auth.ts");
    const method = results.find((f) => f.name.endsWith("authenticate"));
    expect(method).toBeDefined();
    expect(method!.name).toBe("class UserService > authenticate");
    expect(method!.cyclomatic).toBe(2);
  });

  it("scores every function in a file independently", async () => {
    const src = `
function a() { if (true) return 1; return 0; }
function b() { return 1; }
`;
    const results = await computeComplexity(src, "src/multi.ts");
    expect(results).toHaveLength(2);
    const a = results.find((f) => f.name === "a")!;
    const b = results.find((f) => f.name === "b")!;
    expect(a.cyclomatic).toBe(2);
    expect(b.cyclomatic).toBe(1);
  });
});

describe("computeComplexity — Python", () => {
  it("a straight-line function is cyclomatic 1", async () => {
    const src = `
def add(a, b):
    return a + b
`;
    const [fn] = await computeComplexity(src, "src/add.py");
    expect(fn.cyclomatic).toBe(1);
  });

  it("if/elif/else chain: each elif is a branch, plain else is not", async () => {
    const src = `
def classify(x):
    if x == 1:
        return "one"
    elif x == 2:
        return "two"
    else:
        return "other"
`;
    const [fn] = await computeComplexity(src, "src/classify.py");
    expect(fn.cyclomatic).toBe(3); // 1 base + if + elif
  });

  it("and/or, for, while, except each add a decision point", async () => {
    const src = `
def risky(a, b):
    try:
        for i in range(a):
            while i > 0:
                if a and b or not b:
                    i -= 1
    except ValueError:
        return -1
    return 0
`;
    const [fn] = await computeComplexity(src, "src/risky.py");
    // 1 base + for + while + if + and + or + except = 7
    expect(fn.cyclomatic).toBe(7);
  });

  it("nesting raises cognitive complexity", async () => {
    const flat = `
def flat(a, b):
    if a:
        return 1
    if b:
        return 2
    return 0
`;
    const nested = `
def nested(a, b):
    if a:
        if b:
            return 1
    return 0
`;
    const [flatFn] = await computeComplexity(flat, "src/flat.py");
    const [nestedFn] = await computeComplexity(nested, "src/nested.py");
    expect(nestedFn.cognitive).toBeGreaterThan(flatFn.cognitive);
  });
});

describe("computeComplexity — Go", () => {
  it("a straight-line function is cyclomatic 1", async () => {
    const src = `
package main

func add(a, b int) int {
	return a + b
}
`;
    const [fn] = await computeComplexity(src, "src/add.go");
    expect(fn.cyclomatic).toBe(1);
  });

  it("if/else-if, &&/||, and switch cases each add a decision point", async () => {
    const src = `
package main

func classify(a, b int) int {
	if a > 0 && b > 0 {
		return 1
	} else if a < 0 || b < 0 {
		return -1
	}
	switch a {
	case 1:
		return 10
	case 2:
		return 20
	default:
		return 0
	}
}
`;
    const [fn] = await computeComplexity(src, "src/classify.go");
    // 1 base + if + && + (else-if is a nested if_statement) + || + 3 case arms
    expect(fn.cyclomatic).toBe(8);
  });

  it("nesting raises cognitive complexity", async () => {
    const flat = `
package main

func flat(a, b bool) int {
	if a {
		return 1
	}
	if b {
		return 2
	}
	return 0
}
`;
    const nested = `
package main

func nested(a, b bool) int {
	if a {
		if b {
			return 1
		}
	}
	return 0
}
`;
    const [flatFn] = await computeComplexity(flat, "src/flat.go");
    const [nestedFn] = await computeComplexity(nested, "src/nested.go");
    expect(nestedFn.cognitive).toBeGreaterThan(flatFn.cognitive);
  });
});

// --- Optional lizard cross-check ------------------------------------------
// Skips cleanly (does not fail) if `lizard` isn't installed on this
// machine — it's an external tool this module exists to make optional,
// not a required dependency of the test suite.
function lizardAvailable(): boolean {
  try {
    execFileSync("lizard", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIfLizard = lizardAvailable() ? describe : describe.skip;

describeIfLizard("computeComplexity vs lizard (optional cross-check)", () => {
  it("agrees with lizard's cyclomatic complexity within tolerance", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    const src = `
function classify(x: number): string {
  if (x === 1) return "one";
  if (x === 2) return "two";
  if (x === 3) return "three";
  return "other";
}
`;
    const tmpFile = path.join(os.tmpdir(), `lodestone-lizard-${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, src);

    try {
      const [ours] = await computeComplexity(src, tmpFile);
      const output = execFileSync("lizard", [tmpFile]).toString();
      const line = output.split("\n").find((l) => l.includes("classify"));
      expect(line).toBeDefined();
      // lizard's default output columns: NLOC  CCN  token  PARAM  length  location
      const ccn = parseInt(line!.trim().split(/\s+/)[1], 10);
      expect(Math.abs(ccn - ours.cyclomatic)).toBeLessThanOrEqual(1);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});
