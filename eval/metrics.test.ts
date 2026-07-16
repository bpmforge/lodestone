import { describe, it, expect } from "vitest";
import { recallAtK, reciprocalRank, mean } from "./metrics.js";

describe("recallAtK", () => {
  it("is 1 when every relevant path appears in the top-k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 5)).toBe(1);
  });

  it("only counts relevant paths within the first k retrieved", () => {
    expect(recallAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
    expect(recallAtK(["x", "y", "a"], ["a"], 3)).toBe(1);
  });

  it("is the fraction of relevant paths found when only some appear", () => {
    expect(recallAtK(["a", "z"], ["a", "b"], 5)).toBe(0.5);
  });

  it("returns 1 for an empty relevant set (nothing to miss)", () => {
    expect(recallAtK(["a"], [], 5)).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is 1 when the first relevant path is retrieved first", () => {
    expect(reciprocalRank(["a", "b"], ["a"])).toBe(1);
  });

  it("is 1/rank of the first relevant hit", () => {
    expect(reciprocalRank(["x", "y", "a"], ["a"])).toBeCloseTo(1 / 3);
  });

  it("is 0 when no relevant path is retrieved", () => {
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });
});

describe("mean", () => {
  it("averages a list of numbers", () => {
    expect(mean([1, 2, 3])).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(mean([])).toBe(0);
  });
});
