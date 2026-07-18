import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { computeDuplication } from "../metrics/duplication.js";

const DUPED_BLOCK = `function validateUser(user) {
  if (!user) {
    throw new Error("invalid user");
  }
  if (!user.name) {
    throw new Error("missing name");
  }
  if (!user.email) {
    throw new Error("missing email");
  }
  return true;
}`;

function lineOf(content: string, needle: string): number {
  const idx = content.split("\n").findIndex((l) => l.includes(needle));
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx + 1;
}

describe("computeDuplication — clone detection", () => {
  it("finds a planted clone across 2 fixture files", () => {
    const fileA = `export function unrelatedA() {
  return 1;
}

${DUPED_BLOCK}
`;
    const fileB = `import { x } from "./x";

${DUPED_BLOCK}

export function unrelatedB() {
  return 2;
}
`;

    const groups = computeDuplication([
      { path: "src/a.ts", content: fileA },
      { path: "src/b.ts", content: fileB },
    ]);

    const g = groups.find(
      (grp) =>
        grp.occurrences.some((o) => o.path === "src/a.ts") &&
        grp.occurrences.some((o) => o.path === "src/b.ts"),
    );
    expect(g).toBeDefined();
    expect(g!.tokenLength).toBeGreaterThanOrEqual(30);
    expect(g!.hash.length).toBeGreaterThan(0);

    const occA = g!.occurrences.find((o) => o.path === "src/a.ts")!;
    const occB = g!.occurrences.find((o) => o.path === "src/b.ts")!;
    expect(occA.line).toBe(lineOf(fileA, "function validateUser"));
    expect(occB.line).toBe(lineOf(fileB, "function validateUser"));
  });

  it("does not report a clone for unrelated files", () => {
    const fileA = `export function alpha() {
  return 1;
}
`;
    const fileB = `export function beta() {
  return 2;
}
`;
    const groups = computeDuplication([
      { path: "src/alpha.ts", content: fileA },
      { path: "src/beta.ts", content: fileB },
    ]);
    expect(groups).toEqual([]);
  });

  it("returns [] for a single file or empty input", () => {
    expect(computeDuplication([])).toEqual([]);
    expect(
      computeDuplication([{ path: "src/only.ts", content: DUPED_BLOCK }]),
    ).toEqual([]);
  });

  it("honors a higher minTokens threshold by finding nothing below it", () => {
    const fileA = `${DUPED_BLOCK}\n`;
    const fileB = `${DUPED_BLOCK}\n`;
    const groups = computeDuplication(
      [
        { path: "src/a.ts", content: fileA },
        { path: "src/b.ts", content: fileB },
      ],
      { minTokens: 10000 },
    );
    expect(groups).toEqual([]);
  });

  it("normalizes numeric/string literals so near-identical blocks still clone", () => {
    const template = (msg: string, code: number) => `function report() {
  console.log("${msg}");
  console.log("${msg}");
  console.log("${msg}");
  return ${code};
  return ${code};
  return ${code};
  return ${code};
  return ${code};
  return ${code};
  return ${code};
  return ${code};
  return ${code};
}`;
    const fileA = template("hello world", 200);
    const fileB = template("goodbye world", 404);

    const groups = computeDuplication(
      [
        { path: "src/r1.ts", content: fileA },
        { path: "src/r2.ts", content: fileB },
      ],
      { minTokens: 20 },
    );
    expect(groups.length).toBeGreaterThanOrEqual(1);
  });
});

// --- Optional jscpd cross-check ---------------------------------------
// Skips cleanly (does not fail) if `jscpd` isn't installed — it's an
// external tool this module exists to make optional, not a required
// dependency of the test suite.
function jscpdAvailable(): boolean {
  try {
    execFileSync("jscpd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeIfJscpd = jscpdAvailable() ? describe : describe.skip;

describeIfJscpd("computeDuplication vs jscpd (optional cross-check)", () => {
  it("agrees jscpd finds a clone where we do", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lodestone-jscpd-"));
    const fileAPath = path.join(dir, "a.ts");
    const fileBPath = path.join(dir, "b.ts");
    const fileA = `${DUPED_BLOCK}\n`;
    const fileB = `${DUPED_BLOCK}\n`;
    fs.writeFileSync(fileAPath, fileA);
    fs.writeFileSync(fileBPath, fileB);

    try {
      const ours = computeDuplication([
        { path: fileAPath, content: fileA },
        { path: fileBPath, content: fileB },
      ]);
      expect(ours.length).toBeGreaterThanOrEqual(1);

      const output = execFileSync(
        "jscpd",
        [dir, "--reporters", "console", "--min-tokens", "30"],
        { stdio: "pipe" },
      ).toString();
      expect(output).toMatch(/clone|duplicat/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
