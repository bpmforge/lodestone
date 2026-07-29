import { describe, it, expect } from "vitest";
import { computeCouplingOutliers } from "../metrics/couplingOutliers.js";

/** One `shared()` symbol called by all `n` callers (fan-in = n), plus `n`
 *  baseline `definer{i}()` symbols each called exactly once by their own
 *  `caller{i}` (fan-in = 1) — giving the fan-in distribution a real
 *  population of `n + 1` non-zero entities to rank `shared` against
 *  (the callers themselves have fan-in 0 and are correctly excluded from
 *  the population — see module doc's "population is non-zero counts"
 *  rule). */
function buildFanInFixture(
  n: number,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [
    {
      path: "src/shared.ts",
      content: `export function shared() {\n  return 1;\n}\n`,
    },
  ];
  for (let i = 0; i < n; i++) {
    files.push({
      path: `src/definer${i}.ts`,
      content: `export function definer${i}() {\n  return 1;\n}\n`,
    });
    files.push({
      path: `src/caller${i}.ts`,
      content:
        `import { shared } from "./shared";\n` +
        `import { definer${i} } from "./definer${i}";\n` +
        `export function caller${i}() {\n` +
        `  definer${i}();\n` +
        `  return shared();\n` +
        `}\n`,
    });
  }
  return files;
}

describe("computeCouplingOutliers — symbol fan-in", () => {
  it("flags a symbol called by far more distinct callers than the rest of the population", async () => {
    const files = buildFanInFixture(25);
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    const hit = findings.find(
      (f) =>
        f.scope === "symbol" && f.direction === "fan-in" && f.name === "shared",
    );
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(25);
    expect(hit!.definedIn).toEqual(["src/shared.ts"]);
    expect(hit!.percentile).toBeGreaterThanOrEqual(hit!.thresholdPercentile);
  });

  it("does NOT flag the baseline definer{i} symbols — only the true outlier", async () => {
    const files = buildFanInFixture(25);
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    const symbolFanInNames = findings
      .filter((f) => f.scope === "symbol" && f.direction === "fan-in")
      .map((f) => f.name);
    expect(symbolFanInNames).toEqual(["shared"]);
  });

  it("respects a custom percentile cutoff", async () => {
    const files = buildFanInFixture(25);
    // A very high cutoff (0.999) should exclude findings a lower one (0.5)
    // would include, given the same population.
    const strict = await computeCouplingOutliers(files, {
      minSampleSize: 5,
      percentile: 0.999,
    });
    const lenient = await computeCouplingOutliers(files, {
      minSampleSize: 5,
      percentile: 0.5,
    });
    expect(lenient.length).toBeGreaterThanOrEqual(strict.length);
  });

  it("excludes self-recursive calls from a symbol's own fan-in/fan-out", async () => {
    const src = `
export function recurse(n: number) {
  if (n <= 0) return 0;
  return recurse(n - 1);
}
`;
    const findings = await computeCouplingOutliers(
      [{ path: "src/r.ts", content: src }],
      { minSampleSize: 1 },
    );
    expect(
      findings.find((f) => f.scope === "symbol" && f.name === "recurse"),
    ).toBeUndefined();
  });

  it("excludes calls to a name with no matching project def (built-in/library call filter)", async () => {
    // 25 callers all invoke both `shared()` (a real project function) and
    // `.map(...)` on an array literal — `map` is never itself defined
    // anywhere in this file set, so it must not appear as a symbol-level
    // fan-in finding even though its raw call count (25) would otherwise
    // dwarf every real project symbol. Regression test for the dogfood
    // finding documented in couplingOutliers.ts's module doc.
    const files: Array<{ path: string; content: string }> = [
      {
        path: "src/shared.ts",
        content: `export function shared() {\n  return 1;\n}\n`,
      },
    ];
    for (let i = 0; i < 25; i++) {
      // Baseline definer{i}, called exactly once by its own caller{i} —
      // gives the (post-filter) population enough real project symbols to
      // rank against (see buildFanInFixture's doc above for why this is
      // necessary: without it, `shared` would be the population's only
      // member and never clear minSampleSize).
      files.push({
        path: `src/definer${i}.ts`,
        content: `export function definer${i}() {\n  return 1;\n}\n`,
      });
      files.push({
        path: `src/caller${i}.ts`,
        content:
          `import { shared } from "./shared";\n` +
          `import { definer${i} } from "./definer${i}";\n` +
          `export function caller${i}() {\n` +
          `  [1, 2, 3].map((x) => x);\n` +
          `  definer${i}();\n` +
          `  return shared();\n` +
          `}\n`,
      });
    }
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    expect(
      findings.find((f) => f.scope === "symbol" && f.name === "map"),
    ).toBeUndefined();
    expect(
      findings.find((f) => f.scope === "symbol" && f.name === "shared"),
    ).toBeDefined();
  });

  it("does not report anything below minSampleSize (statistical-validity guard)", async () => {
    // n=3 -> population of 4 non-zero-count symbols, far below the
    // *default* minSampleSize (20) even though "shared" is clearly more
    // called than the rest.
    const findings = await computeCouplingOutliers(buildFanInFixture(3));
    expect(findings).toEqual([]);
  });

  it("a perfectly flat distribution (everyone tied) has zero outliers", async () => {
    // 30 symbols, each called by exactly 2 distinct callers — nobody
    // deviates from the population, so nothing is a statistical outlier
    // relative to "the rest" (there is no "rest" with a different value).
    // Flagging all 30 here would be exactly the noise the ticket's
    // percentile-not-magic-threshold requirement exists to avoid.
    const files: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < 30; i++) {
      files.push({
        path: `src/def${i}.ts`,
        content: `export function fn${i}() {\n  return 1;\n}\n`,
      });
      files.push({
        path: `src/caller${i}a.ts`,
        content:
          `import { fn${i} } from "./def${i}";\n` +
          `export function callerA${i}() { return fn${i}(); }\n`,
      });
      files.push({
        path: `src/caller${i}b.ts`,
        content:
          `import { fn${i} } from "./def${i}";\n` +
          `export function callerB${i}() { return fn${i}(); }\n`,
      });
    }
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    expect(
      findings.filter((f) => f.scope === "symbol" && f.direction === "fan-in"),
    ).toEqual([]);
  });

  it("reports every entity tied AT the outlier value, not an arbitrary subset", async () => {
    // 40 baseline symbols with fan-in = 1, plus 5 "hot" symbols tied at
    // fan-in = 10. All 5 hot symbols sit at the same rank and must all be
    // reported — a broken implementation could plausibly report only the
    // first one found.
    const files: Array<{ path: string; content: string }> = [];
    for (let i = 0; i < 40; i++) {
      files.push({
        path: `src/base${i}.ts`,
        content: `export function base${i}() {\n  return 1;\n}\n`,
      });
      files.push({
        path: `src/baseCaller${i}.ts`,
        content:
          `import { base${i} } from "./base${i}";\n` +
          `export function baseCaller${i}() { return base${i}(); }\n`,
      });
    }
    for (let h = 0; h < 5; h++) {
      files.push({
        path: `src/hot${h}.ts`,
        content: `export function hot${h}() {\n  return 1;\n}\n`,
      });
      for (let c = 0; c < 10; c++) {
        files.push({
          path: `src/hotCaller${h}_${c}.ts`,
          content:
            `import { hot${h} } from "./hot${h}";\n` +
            `export function hotCaller${h}_${c}() { return hot${h}(); }\n`,
        });
      }
    }
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
      percentile: 0.8,
    });
    const fanIn = findings.filter(
      (f) => f.scope === "symbol" && f.direction === "fan-in",
    );
    expect(fanIn.map((f) => f.name).sort()).toEqual([
      "hot0",
      "hot1",
      "hot2",
      "hot3",
      "hot4",
    ]);
    for (const f of fanIn) expect(f.count).toBe(10);
  });

  it("returns [] for empty input", async () => {
    expect(await computeCouplingOutliers([])).toEqual([]);
  });
});

describe("computeCouplingOutliers — file fan-in/fan-out", () => {
  /** Mirrors buildFanInFixture at file granularity: `hub.ts` imported by
   *  all `n` leaves (fan-in = n) vs. `n` baseline `util{i}.ts` files each
   *  imported by exactly one leaf (fan-in = 1). */
  function buildFileFanInFixture(
    n: number,
  ): Array<{ path: string; content: string }> {
    const files: Array<{ path: string; content: string }> = [
      { path: "src/hub.ts", content: `export const hub = 1;\n` },
    ];
    for (let i = 0; i < n; i++) {
      files.push({
        path: `src/util${i}.ts`,
        content: `export const util${i} = 1;\n`,
      });
      files.push({
        path: `src/leaf${i}.ts`,
        content:
          `import { hub } from "./hub";\n` +
          `import { util${i} } from "./util${i}";\n` +
          `export const leaf${i} = hub + util${i};\n`,
      });
    }
    return files;
  }

  it("flags a file imported by far more distinct files than the rest of the population", async () => {
    const files = buildFileFanInFixture(25);
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    const hit = findings.find(
      (f) =>
        f.scope === "file" &&
        f.direction === "fan-in" &&
        f.name === "src/hub.ts",
    );
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(25);
  });

  it("does NOT flag the baseline util{i}.ts files — only the true outlier", async () => {
    const files = buildFileFanInFixture(25);
    const findings = await computeCouplingOutliers(files, {
      minSampleSize: 5,
    });
    const fileFanInNames = findings
      .filter((f) => f.scope === "file" && f.direction === "fan-in")
      .map((f) => f.name);
    expect(fileFanInNames).toEqual(["src/hub.ts"]);
  });

  it("excludes a self-referential import from a file's own fan-in/fan-out", async () => {
    const src = `import { helper } from "./a";\nexport function helper() { return 1; }\n`;
    const findings = await computeCouplingOutliers(
      [{ path: "src/a.ts", content: src }],
      { minSampleSize: 1 },
    );
    expect(
      findings.find((f) => f.scope === "file" && f.name === "src/a.ts"),
    ).toBeUndefined();
  });
});
