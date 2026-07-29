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
 * split on non-alphanumeric + camelCase boundaries). Plain substring matching
 * would false-positive badly on short terms (`log` inside "logi**n**", `env`
 * inside "**env**ironment", `iv` inside "pr**iv**ate").
 *
 * A concept matches if its key OR one of its terms matches. An identifier
 * (key or term) is split into subtokens (`ssrf_outbound` -> `ssrf`,
 * `outbound`); the ones that are GENERIC (see `isGenericToken()`) are
 * ignored as candidates, and the concept matches if the query contains any
 * ONE of the remaining, distinctive subtokens. Only when EVERY subtoken of
 * an identifier is generic does matching fall back to requiring the whole
 * phrase (all subtokens present).
 *
 * This is W4-05's fix for a precision bug: the pre-fix matcher fired on any
 * ONE shared subtoken with no generic-word filter, so multi-word identifiers
 * shed generic English words (`code` from `code_signing`, `assignment` from
 * the key `mass_assignment`) into the match set — a query merely containing
 * that common word pulled in whatever concept happened to contain it as a
 * compound fragment (e.g. "dead code" wrongly matched `software_data_integrity`,
 * "unused assignment" wrongly matched `mass_assignment`).
 *
 * An earlier version of this fix required the WHOLE phrase for every
 * multi-word identifier, key or term, with no generic/distinctive
 * distinction. That over-corrected: `ssrf_outbound`'s key needs both `ssrf`
 * AND `outbound`, so a bare "SSRF" query — exactly how CWE/OWASP shorthand
 * is used in practice — stopped matching, along with "rate limiting" (needs
 * `rate`+`limiting`+`dos`), "secrets" (`secrets`+`config`), and "logging"
 * (`logging`+`audit`). The generic/distinctive split fixes the precision
 * bug without that recall cost: `ssrf` is distinctive (it doesn't collide
 * with any other concept), so it alone still anchors `ssrf_outbound`, while
 * `assignment` is on the generic denylist so it alone can't anchor
 * `mass_assignment`. See `isGenericToken()`, `identifierMatches()`, and
 * src/tests/ontology.test.ts's "W4-05" describe blocks.
 */

import { existsSync, readFileSync } from "node:fs";
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

/**
 * Walk up from `startDir` to the nearest ancestor containing a
 * package.json — the package root, regardless of how deep this module
 * lives under it. A fixed `../..` relative to `__dirname` (the previous
 * approach) only worked when this file ran straight out of `src/ontology/`;
 * it silently pointed one directory ABOVE the repo once tsup bundled it
 * into a single `dist/*.js` file (W3-10 — caught because a plain-node
 * consumer of the built package hit ENOENT on the default ontology path).
 */
function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached filesystem root — give up, keep original
    dir = parent;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ONTOLOGY_PATH = path.join(
  findPackageRoot(__dirname),
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

/**
 * A small, hand-justified set of generic programming/English nouns that
 * should never anchor a match on their own, even when they don't happen to
 * collide with another concept in this particular ontology. These are the
 * kind of context-free words a routine finding (a dead-code report, an
 * "unused variable" lint, ...) mentions constantly regardless of any
 * specific vulnerability class — `assignment` is the concrete case: nothing
 * else in the ontology contains it (so the collision-count signal below
 * doesn't catch it), but it's exactly as generic as `code`/`data`/`output`,
 * and is the token responsible for "unused assignment" wrongly matching
 * `mass_assignment` via that concept's own key. Kept intentionally short —
 * see `computeCollisionGenericTokens()` for the data-driven majority of
 * generic-token detection.
 */
const MANUAL_GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "code",
  "data",
  "output",
  "input",
  "assignment",
  "handling",
  "management",
  "storage",
  "config",
  "file",
  "path",
  "check",
  "access",
]);

/** Grammatical function words: never distinctive regardless of collision status. */
const STOPWORD_TOKENS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "in",
  "on",
  "at",
  "by",
  "to",
  "from",
  "and",
  "or",
  "for",
  "with",
  "is",
  "are",
]);

const collisionGenericCache = new WeakMap<Ontology, Set<string>>();

/**
 * Data-driven generic-token detection: a subtoken is "collision-generic" if
 * it's owned (appears in the key or a term) by 2+ DISTINCT concepts in the
 * ontology. Cheap evidence that the word is a common fragment rather than a
 * specific identifier — e.g. `code` is shed by both `software_data_integrity`
 * (`code_signing`) and `llm_output_handling` (`code_execution_from_output`);
 * `execution` collides between `command_execution`'s own key and
 * `llm_output_handling`'s `code_execution_from_output` term; `llm` collides
 * across all 11 `llm_*` concepts. Self-maintaining: adding or renaming
 * concepts in ontology/concepts.yaml recomputes this automatically, unlike a
 * hardcoded list. Cached per `Ontology` object (parallel to
 * `getDefaultOntology()`'s own caching) since `expand()` may be called
 * per-query against the same loaded ontology.
 */
function computeCollisionGenericTokens(ontology: Ontology): Set<string> {
  const cached = collisionGenericCache.get(ontology);
  if (cached) return cached;

  const owners = new Map<string, Set<string>>();
  for (const concept of ontology.concepts) {
    const subtokens = new Set<string>([
      ...splitIdentifier(concept.key),
      ...concept.terms.flatMap((term) => splitIdentifier(term)),
    ]);
    for (const tok of subtokens) {
      let ownerSet = owners.get(tok);
      if (!ownerSet) {
        ownerSet = new Set();
        owners.set(tok, ownerSet);
      }
      ownerSet.add(concept.key);
    }
  }

  const generic = new Set<string>();
  for (const [tok, ownerSet] of owners) {
    if (ownerSet.size >= 2) generic.add(tok);
  }
  collisionGenericCache.set(ontology, generic);
  return generic;
}

/** Whether a subtoken is too generic to independently anchor a concept match. */
function isGenericToken(token: string, collisionGeneric: Set<string>): boolean {
  return (
    MANUAL_GENERIC_TOKENS.has(token) ||
    STOPWORD_TOKENS.has(token) ||
    collisionGeneric.has(token)
  );
}

/**
 * Whether a single identity string (a concept's key, or one of its terms)
 * matches the query's token set.
 *
 * Split the identifier into subtokens and separate out the DISTINCTIVE ones
 * (not generic per `isGenericToken()`). If there's at least one distinctive
 * subtoken, the identifier matches when the query contains ANY of them —
 * generic subtokens in the same identifier are ignored, neither required
 * nor sufficient (e.g. `ssrf_outbound` -> `ssrf` is distinctive, `outbound`
 * is not collision-generic either, so both anchor it independently; but
 * `code_signing` -> `code` is generic so it's ignored, leaving `signing`
 * as the sole anchor). If EVERY subtoken is generic (e.g.
 * `code_execution_from_output` -> code/execution/output are all generic),
 * fall back to requiring the whole phrase, so the identifier is still
 * reachable by typing it out in full rather than being permanently inert.
 *
 * This applies uniformly to the concept key and to terms: the key is just
 * the concept's canonical identity string and is exactly as prone to
 * shedding a generic word as any other multi-word term (`mass_assignment`'s
 * own key sheds `assignment` the same way its `code_signing`-style terms
 * shed `code` elsewhere in the ontology — see W4-05).
 */
function identifierMatches(
  identifier: string,
  queryTokens: Set<string>,
  collisionGeneric: Set<string>,
): boolean {
  const subtokens = splitIdentifier(identifier);
  if (subtokens.length === 0) return false;
  const distinctive = subtokens.filter(
    (tok) => !isGenericToken(tok, collisionGeneric),
  );
  if (distinctive.length > 0) {
    return distinctive.some((tok) => queryTokens.has(tok));
  }
  return subtokens.every((tok) => queryTokens.has(tok));
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
  const collisionGeneric = computeCollisionGenericTokens(ontology);
  const matched: OntologyConcept[] = [];
  for (const concept of ontology.concepts) {
    const isMatch =
      identifierMatches(concept.key, queryTokens, collisionGeneric) ||
      concept.terms.some((term) =>
        identifierMatches(term, queryTokens, collisionGeneric),
      );
    if (isMatch) matched.push(concept);
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
