import { describe, it, expect } from "vitest";
import { expand, parseOntology, loadOntology } from "../ontology/index.js";

describe("loadOntology", () => {
  it("loads the seeded ontology/concepts.yaml with the expected concepts", () => {
    const ontology = loadOntology();
    const keys = ontology.concepts.map((c) => c.key);
    expect(keys).toContain("password_storage");
    expect(keys).toContain("authentication");
    expect(ontology.concepts.length).toBeGreaterThanOrEqual(19);
  });
});

describe("expand", () => {
  it("expands a query touching password_storage into its terms and packages", () => {
    const result = expand("where is password handling");
    expect(result.concepts).toContain("password_storage");
    expect(result.terms).toEqual(
      expect.arrayContaining(["bcrypt", "argon2", "hash"]),
    );
    expect(result.packages).toEqual(
      expect.arrayContaining(["bcrypt", "argon2"]),
    );
  });

  it("unions terms across multiple lexically-matched concepts (password_storage + authentication)", () => {
    // NOTE: "where is password handling" alone only lexically matches
    // password_storage (via "password") — none of authentication's terms
    // (login, credential, ...) are substrings/subtokens of that phrase.
    // Adding "login" here exercises the multi-concept union deliberately;
    // see handoff_notes for the design-doc example this clarifies.
    const result = expand("where is password login handling");
    expect(result.concepts).toEqual(
      expect.arrayContaining(["password_storage", "authentication"]),
    );
    expect(result.terms).toEqual(
      expect.arrayContaining([
        "bcrypt",
        "argon2",
        "hash",
        "credential",
        "login",
      ]),
    );
  });

  it("is case-insensitive", () => {
    const result = expand("WHERE IS PASSWORD HANDLING");
    expect(result.concepts).toContain("password_storage");
  });

  it("returns empty concepts/terms/packages for a query matching no concept", () => {
    const result = expand("the quick brown fox jumps over the lazy dog");
    expect(result).toEqual({ concepts: [], terms: [], packages: [] });
  });

  it("does not false-positive on short terms as substrings (log inside login, env inside environment)", () => {
    // "login" contains "log" (logging_audit) and "environment" contains "env"
    // (secrets_config) as raw substrings, but neither should match because
    // matching is whole-token, not substring.
    const result = expand("login page and environment setup");
    expect(result.concepts).not.toContain("logging_audit");
    expect(result.concepts).not.toContain("secrets_config");
    expect(result.concepts).toContain("authentication"); // via "login"
  });

  it("splits multi-word terms into subtokens (access_token -> access, token)", () => {
    const result = expand("access_token verification");
    expect(result.concepts).toContain("tokens_jwt");
    expect(result.terms).toEqual(expect.arrayContaining(["access", "token"]));
  });
});

describe("parseOntology", () => {
  it("parses a minimal ontology fixture into the structured shape", () => {
    const yamlText = `
version: 0.1
concepts:
  widgets:
    cwe: [1, 2]
    terms: [widget, gadget_maker]
    packages:
      npm: [widget-lib]
`;
    const ontology = parseOntology(yamlText);
    expect(ontology.version).toBe("0.1");
    expect(ontology.concepts).toEqual([
      {
        key: "widgets",
        cwe: [1, 2],
        terms: ["widget", "gadget_maker"],
        packages: { npm: ["widget-lib"] },
      },
    ]);
  });

  it("defaults missing cwe/terms/packages to empty", () => {
    const ontology = parseOntology(`
version: 0.1
concepts:
  bare: {}
`);
    expect(ontology.concepts).toEqual([
      { key: "bare", cwe: [], terms: [], packages: {} },
    ]);
  });
});
