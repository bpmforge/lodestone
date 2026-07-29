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

describe("expand() — W4-05 concept-side precision (multi-word terms don't shed generic subtokens)", () => {
  // Root cause: conceptMatchTokens() used to subtoken-split every concept
  // term and match a query on ANY single shared token. Multi-word terms
  // like `code_signing`, `mass_assignment`, `code_execution_from_output`
  // shed generic English words (code, assignment, output) into the match
  // set, so a query merely containing that common word pulled in an
  // unrelated concept. Fix: a multi-word term must now match as a whole
  // phrase (every one of its subtokens present in the query), not any one.

  it("does not expand 'dead code' into software_data_integrity (code_signing false hit)", () => {
    const result = expand("dead code");
    expect(result.concepts).not.toContain("software_data_integrity");
  });

  it("does not expand 'dead code' into llm_output_handling (code_execution_from_output false hit)", () => {
    const result = expand("dead code");
    expect(result.concepts).not.toContain("llm_output_handling");
  });

  it("does not expand 'unused assignment' into mass_assignment (mass_assignment false hit)", () => {
    const result = expand("unused assignment");
    expect(result.concepts).not.toContain("mass_assignment");
  });

  it("DOES expand 'mass assignment' into mass_assignment when both words are present (true phrase match)", () => {
    const result = expand("mass assignment vulnerability in the model binder");
    expect(result.concepts).toContain("mass_assignment");
  });

  it("DOES expand 'code signing bypass' into software_data_integrity (both words of code_signing present)", () => {
    const result = expand("code signing bypass");
    expect(result.concepts).toContain("software_data_integrity");
  });

  it("does not expand bare 'llm' into any llm_* concept (collision-generic token, not a hand-curated one)", () => {
    // "llm" isn't on MANUAL_GENERIC_TOKENS -- it's only excluded because
    // computeCollisionGenericTokens() detects it's owned by all 11 llm_*
    // concepts' keys. Without that data-driven detection, "llm" alone would
    // be "distinctive" for each of those 11 multi-word keys individually
    // (e.g. llm_prompt_injection -> llm/prompt/injection, none hand-curated
    // generic) and match every one of them.
    const result = expand("llm");
    expect(result.concepts).toEqual([]);
  });

  it("does not expand bare 'execution' into command_execution or llm_output_handling (collision-generic)", () => {
    // "execution" collides between command_execution's own key and
    // llm_output_handling's code_execution_from_output term -- neither
    // concept's key/term has any OTHER distinctive subtoken this query
    // supplies, so both stay unmatched.
    const result = expand("execution");
    expect(result.concepts).toEqual([]);
  });
});

describe("expand() — W4-05 recall preserved (fix must not tank true positives)", () => {
  it("still expands an SSRF-ish query into ssrf_outbound via the single-word term 'fetch'", () => {
    const result = expand("SSRF vulnerability in the fetch call");
    expect(result.concepts).toContain("ssrf_outbound");
  });

  it("still expands an auth query into authentication via a single-word term", () => {
    const result = expand("user login flow");
    expect(result.concepts).toContain("authentication");
  });

  it("still matches accessToken (camelCase query) against the access_token term", () => {
    const result = expand("accessToken verification");
    expect(result.concepts).toContain("tokens_jwt");
    expect(result.terms).toEqual(expect.arrayContaining(["access", "token"]));
  });

  it("the finding.concept production path (exact concept-key string) always reaches its own concept", () => {
    // src/packet/index.ts feeds a rulepack's `finding.concept` (the concept
    // KEY string, e.g. "ssrf_outbound") into expand() as the first-priority
    // seed, ahead of free-text message/ruleId fallbacks. Every multi-word
    // key's own full text trivially satisfies the whole-phrase fallback (all
    // its subtokens are present when you type the whole key), so this
    // primary, structured path is unaffected by the fix regardless of which
    // subtokens are generic — verified here for a representative sample
    // including the two multi-word keys exercised elsewhere in this file.
    for (const key of [
      "ssrf_outbound",
      "mass_assignment",
      "software_data_integrity",
      "llm_output_handling",
    ]) {
      expect(expand(key).concepts).toContain(key);
    }
  });
});

describe("expand() — W4-05 realistic short queries (generic vs. distinctive subtokens)", () => {
  // A first version of this fix required the WHOLE phrase for every
  // multi-word identifier (key or term), with no generic/distinctive
  // distinction. That over-corrected: it fixed the reported bug but broke
  // recall on exactly the short, real-world queries this engine exists to
  // serve — a coordinator-run survey against that version found "SSRF",
  // "rate limiting", "secrets", and "logging" all returned nothing, while
  // "dead code"/"unused assignment" (the actual bug) correctly stayed
  // empty. This pins that full survey as a regression test: it fails if a
  // future change reintroduces the over-broad whole-phrase-only rule (all
  // four MISS rows below would go back to `[]`) AND fails if a future
  // change reintroduces the original ANY-subtoken bug (the two bug rows
  // below would stop being `[]`).
  it("matches short, realistic security queries by their distinctive subtoken", () => {
    const realisticHits: Array<[string, string]> = [
      ["SSRF", "ssrf_outbound"],
      ["rate limiting", "rate_limiting_dos"],
      ["secrets", "secrets_config"],
      ["logging", "logging_audit"],
      ["XSS", "input_validation"],
      ["csrf", "session_management"],
      ["path traversal", "file_upload_path"],
    ];
    for (const [query, expectedConcept] of realisticHits) {
      expect(expand(query).concepts).toContain(expectedConcept);
    }
  });

  it("still returns nothing for the original W4-05 bug queries (generic-word-only matches)", () => {
    for (const query of ["dead code", "unused assignment", "unused variable"]) {
      expect(expand(query).concepts).toEqual([]);
    }
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
