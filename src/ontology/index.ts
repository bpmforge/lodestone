/**
 * Concept-ontology loader + query expander (see docs/LODESTONE_DESIGN.md §4.5, §5).
 *
 * The ontology (`ontology/concepts.yaml`) is a curated CWE/OWASP keyword map:
 * each concept has `terms` (identifier fragments), `packages` (per-ecosystem
 * package names), and `cwe` (primary CWE anchors). `expand(query)` matches the
 * query against concept keys/terms with zero LLM calls and returns the union
 * of matched concepts' terms, subtokens, and package names — the Tier-1
 * retrieval layer's query-expansion step.
 *
 * Matching is whole-token, not substring: the query is tokenized (lowercased,
 * split on non-alphanumeric + camelCase boundaries) and a concept matches
 * only if its key or one of its terms shares a token with the query. Plain
 * substring matching would false-positive badly on short terms (`log` inside
 * "logi**n**", `env` inside "**env**ironment", `iv` inside "pr**iv**ate").
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { splitIdentifier } from "../search/subtokens.js";

export interface OntologyConcept {
  key: string;
  cwe: number[];
  terms: string[];
  packages: Record<string, string[]>;
}

export interface Ontology {
  version: string;
  concepts: OntologyConcept[];
}

export interface ExpandResult {
  concepts: string[];
  terms: string[];
  packages: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ONTOLOGY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "ontology",
  "concepts.yaml",
);

interface RawConceptEntry {
  cwe?: number[];
  terms?: string[];
  packages?: Record<string, string[]>;
}

interface RawOntologyFile {
  version?: string | number;
  concepts?: Record<string, RawConceptEntry>;
}

/** Parse an ontology YAML file's raw text into the structured shape used by `expand()`. */
export function parseOntology(yamlText: string): Ontology {
  const raw = parseYaml(yamlText) as RawOntologyFile;
  const concepts: OntologyConcept[] = Object.entries(raw.concepts ?? {}).map(
    ([key, entry]) => ({
      key,
      cwe: entry.cwe ?? [],
      terms: entry.terms ?? [],
      packages: entry.packages ?? {},
    }),
  );
  return { version: String(raw.version ?? ""), concepts };
}

/** Load the ontology from disk. Defaults to `ontology/concepts.yaml` at the repo root. */
export function loadOntology(
  filePath: string = DEFAULT_ONTOLOGY_PATH,
): Ontology {
  const text = readFileSync(filePath, "utf-8");
  return parseOntology(text);
}

let defaultOntology: Ontology | undefined;

/** Lazily load and cache the default `ontology/concepts.yaml` ontology. */
function getDefaultOntology(): Ontology {
  if (!defaultOntology) defaultOntology = loadOntology();
  return defaultOntology;
}

/**
 * Tokenize free text for ontology matching: lowercase, split on non-alphanumeric
 * boundaries and camelCase runs, de-duplicated. Reuses the identifier subtoken
 * splitter so multi-word terms (`access_token`) and query text match the same way.
 */
function tokenize(text: string): Set<string> {
  return new Set(splitIdentifier(text));
}

/** All match tokens for a concept: its key plus every term, each subtoken-split. */
function conceptMatchTokens(concept: OntologyConcept): Set<string> {
  const tokens = new Set<string>();
  for (const tok of splitIdentifier(concept.key)) tokens.add(tok);
  for (const term of concept.terms) {
    for (const tok of splitIdentifier(term)) tokens.add(tok);
  }
  return tokens;
}

/**
 * Expand a free-text query into the union of terms/packages of every concept
 * that lexically matches it (concept key or a concept term shares a token
 * with the query). Case-insensitive, zero LLM calls. Returns empty arrays
 * when no concept matches.
 *
 * `ontology` defaults to the lazily-loaded, cached `ontology/concepts.yaml`;
 * pass an explicit one (e.g. from `parseOntology`) in tests or callers that
 * want a different ontology file.
 */
export function expand(
  query: string,
  ontology: Ontology = getDefaultOntology(),
): ExpandResult {
  const queryTokens = tokenize(query);
  const matched: OntologyConcept[] = [];
  for (const concept of ontology.concepts) {
    const conceptTokens = conceptMatchTokens(concept);
    for (const tok of conceptTokens) {
      if (queryTokens.has(tok)) {
        matched.push(concept);
        break;
      }
    }
  }

  const concepts = new Set<string>();
  const terms = new Set<string>();
  const packages = new Set<string>();

  for (const concept of matched) {
    concepts.add(concept.key);
    for (const term of concept.terms) {
      terms.add(term);
      for (const tok of splitIdentifier(term)) terms.add(tok);
    }
    for (const pkgList of Object.values(concept.packages)) {
      for (const pkg of pkgList) packages.add(pkg);
    }
  }

  return {
    concepts: [...concepts],
    terms: [...terms],
    packages: [...packages],
  };
}
