import { describe, it, expect } from "vitest";
import { splitIdentifier, subtokenText } from "../search/subtokens.js";

describe("splitIdentifier", () => {
  it("splits camelCase", () => {
    expect(splitIdentifier("validateUserPassword")).toEqual([
      "validate",
      "user",
      "password",
    ]);
  });

  it("splits PascalCase", () => {
    expect(splitIdentifier("UserService")).toEqual(["user", "service"]);
  });

  it("splits snake_case", () => {
    expect(splitIdentifier("foo_bar_baz")).toEqual(["foo", "bar", "baz"]);
  });

  it("splits SCREAMING_SNAKE_CASE", () => {
    expect(splitIdentifier("MAX_RETRY_COUNT")).toEqual([
      "max",
      "retry",
      "count",
    ]);
  });

  it("splits kebab-case", () => {
    expect(splitIdentifier("my-component-name")).toEqual([
      "my",
      "component",
      "name",
    ]);
  });

  it("splits acronym runs (upper->upper+lower boundary)", () => {
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
  });

  it("splits letter/digit boundaries", () => {
    expect(splitIdentifier("parseV2Config")).toEqual([
      "parse",
      "v",
      "2",
      "config",
    ]);
  });

  it("returns a single lowercase token for a plain word", () => {
    expect(splitIdentifier("password")).toEqual(["password"]);
  });

  it("returns [] for empty input", () => {
    expect(splitIdentifier("")).toEqual([]);
  });
});

describe("subtokenText", () => {
  it("de-dups subtokens across multiple identifiers and space-joins them", () => {
    const text = subtokenText(["validateUserPassword", "userRepository"]);
    expect(text.split(" ").sort()).toEqual(
      ["password", "repository", "user", "validate"].sort(),
    );
  });

  it("returns empty string for no identifiers", () => {
    expect(subtokenText([])).toBe("");
  });
});
