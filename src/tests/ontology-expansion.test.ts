import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expand, loadOntology } from "../ontology/index.js";

// W4-01: validates the expanded ontology/concepts.yaml (20 -> 42 concepts:
// OWASP Top-10 web 2021 + OWASP LLM Top-10 2025 + CWE Top-25 breadth).
// Does NOT touch expand() semantics — data-only validation + spot checks.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ONTOLOGY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "ontology",
  "concepts.yaml",
);

describe("ontology validator", () => {
  it("parses without throwing", () => {
    expect(() => loadOntology()).not.toThrow();
  });

  it("has at least 40 concepts after the W4-01 expansion", () => {
    const ontology = loadOntology();
    expect(ontology.concepts.length).toBeGreaterThanOrEqual(40);
  });

  it("every concept has non-empty terms", () => {
    const ontology = loadOntology();
    const empty = ontology.concepts.filter((c) => c.terms.length === 0);
    expect(empty.map((c) => c.key)).toEqual([]);
  });

  it("every concept has at least one CWE anchor", () => {
    const ontology = loadOntology();
    const missing = ontology.concepts.filter((c) => c.cwe.length === 0);
    expect(missing.map((c) => c.key)).toEqual([]);
  });

  it("every CWE anchor is a positive integer", () => {
    const ontology = loadOntology();
    for (const concept of ontology.concepts) {
      for (const id of concept.cwe) {
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate concept keys in the raw YAML source", () => {
    const text = readFileSync(ONTOLOGY_PATH, "utf-8");
    // Top-level concept keys are two-space indented `key:` lines directly
    // under `concepts:`. Collect them and assert no repeats — a duplicate
    // YAML mapping key would otherwise silently overwrite the earlier entry.
    const keyLines = text.match(/^  [a-z][a-z0-9_]*:\s*$/gm) ?? [];
    const keys = keyLines.map((l) => l.trim().replace(/:$/, ""));
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of keys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);
  });

  it("the loaded ontology has no duplicate concept keys", () => {
    const ontology = loadOntology();
    const keys = ontology.concepts.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers all CWE Top-25 (2024) ids somewhere in the ontology", () => {
    const ontology = loadOntology();
    const allCwe = new Set(ontology.concepts.flatMap((c) => c.cwe));
    const top25 = [
      79, 787, 89, 352, 22, 125, 78, 416, 862, 434, 94, 20, 77, 287, 269, 502,
      200, 863, 918, 119, 476, 798, 190, 400, 306,
    ];
    const missing = top25.filter((id) => !allCwe.has(id));
    expect(missing).toEqual([]);
  });
});

describe("expand() spot checks on new W4-01 concepts", () => {
  it("expands a prompt-injection query into llm_prompt_injection terms", () => {
    const result = expand("check for prompt_injection in the agent tool call");
    expect(result.concepts).toContain("llm_prompt_injection");
    expect(result.terms).toEqual(
      expect.arrayContaining(["jailbreak", "prompt", "injection"]),
    );
  });

  it("expands a memory-safety query (use_after_free) into memory_safety terms", () => {
    const result = expand("audit this use_after_free path in the parser");
    expect(result.concepts).toContain("memory_safety");
    expect(result.terms).toEqual(
      expect.arrayContaining(["use", "after", "free", "double_free"]),
    );
  });

  it("expands an xxe query into xxe_xml terms and packages", () => {
    const result = expand("xxe external_entity in the xml_parser config");
    expect(result.concepts).toContain("xxe_xml");
    expect(result.packages).toEqual(
      expect.arrayContaining(["defusedxml", "lxml"]),
    );
  });

  it("expands a prototype_pollution query into terms and packages", () => {
    const result = expand("guard against prototype_pollution in deep_merge");
    expect(result.concepts).toContain("prototype_pollution");
    expect(result.terms).toEqual(
      expect.arrayContaining(["deep_merge", "merge"]),
    );
    expect(result.packages).toEqual(expect.arrayContaining(["lodash"]));
  });

  it("expands an open_redirect query into open_redirect terms", () => {
    const result = expand("validate the open_redirect target before redirect");
    expect(result.concepts).toContain("open_redirect");
  });

  it("expands a supply_chain query into supply_chain_dependencies terms", () => {
    const result = expand("flag any typosquat package in the lockfile");
    expect(result.concepts).toContain("supply_chain_dependencies");
  });
});
