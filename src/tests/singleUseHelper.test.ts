import { describe, it, expect } from "vitest";
import { computeSingleUseHelper } from "../metrics/singleUseHelper.js";

describe("computeSingleUseHelper — R-07 single-use helper functions", () => {
  it("flags a helper called from exactly one call site", async () => {
    const src = `
function formatUserLabel(user) {
  return user.name + " <" + user.email + ">";
}

export function renderCard(user) {
  return formatUserLabel(user);
}
`;
    const findings = await computeSingleUseHelper([
      { path: "src/card.ts", content: src },
    ]);

    const hit = findings.find((f) => f.symbol === "formatUserLabel");
    expect(hit).toBeDefined();
    expect(hit!.rule).toBe("R-07");
    expect(hit!.callSite.path).toBe("src/card.ts");
    expect(hit!.path).toBe("src/card.ts");
  });

  it("does NOT flag a helper called from two call sites (clean case)", async () => {
    const src = `
function formatUserLabel(user) {
  return user.name;
}

export function renderCard(user) {
  return formatUserLabel(user);
}

export function renderSummary(user) {
  return formatUserLabel(user);
}
`;
    const findings = await computeSingleUseHelper([
      { path: "src/card.ts", content: src },
    ]);

    expect(
      findings.find((f) => f.symbol === "formatUserLabel"),
    ).toBeUndefined();
  });

  it("does NOT flag a helper with zero call sites (different problem — dead code)", async () => {
    const src = `
export function neverCalled() {
  return 1;
}
`;
    const findings = await computeSingleUseHelper([
      { path: "src/unused.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "neverCalled")).toBeUndefined();
  });

  it("does not report methods (interface/override false-positive risk)", async () => {
    const src = `
export class Service {
  onlyCalledOnce() {
    return 1;
  }
}

export function driver(s: Service) {
  return s.onlyCalledOnce();
}
`;
    const findings = await computeSingleUseHelper([
      { path: "src/service.ts", content: src },
    ]);

    expect(findings.find((f) => f.symbol === "onlyCalledOnce")).toBeUndefined();
  });

  it("counts a call site in a different file toward the single-use total", async () => {
    const defs = `
export function computeTotal(items) {
  return items.length;
}
`;
    const consumer = `
import { computeTotal } from "./defs";

export function checkout(items) {
  return computeTotal(items);
}
`;
    const findings = await computeSingleUseHelper([
      { path: "src/defs.ts", content: defs },
      { path: "src/consumer.ts", content: consumer },
    ]);

    const hit = findings.find((f) => f.symbol === "computeTotal");
    expect(hit).toBeDefined();
    expect(hit!.callSite.path).toBe("src/consumer.ts");
  });

  it("returns [] for empty input", async () => {
    expect(await computeSingleUseHelper([])).toEqual([]);
  });
});
