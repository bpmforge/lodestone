import type { CodeSearchDb } from "../db.js";
import { toFtsQuery } from "../search.js";
import {
  loadOntology,
  type Ontology,
  type OntologyConcept,
} from "../ontology/index.js";
import type { Finding } from "./index.js";

/**
 * Coverage-gap escalation signal (docs/LODESTONE_DESIGN.md §6 follow-on,
 * W4-02): the deterministic reason to escalate a scoped LLM pass. For every
 * ontology concept, ask two zero-LLM questions against this repo's index —
 *
 *   1. Is the concept PRESENT? Do its terms show up anywhere in the indexed
 *      code (chunks_fts — the same store Tier-1 retrieval and evidencePacket
 *      already read)?
 *   2. Is the concept COVERED? Did any Tier-0 rule-pack finding land on it —
 *      either directly (`finding.concept` matches the concept key) or via
 *      CWE overlap (`finding.cwe` intersects the concept's `cwe` anchors,
 *      the AUTHORING.md provenance convention)?
 *
 * present-but-uncovered concepts are the gaps: security surface an engineer
 * clearly built (auth code, payment code, crypto code, ...) that the
 * deterministic rule packs never fired on — worth a scoped LLM look. A
 * concept absent from the code isn't a gap (nothing to scan); a concept
 * present AND covered by a finding isn't a gap either (already found).
 */

export interface CoverageGap {
  /** Ontology concept key, e.g. "authentication". */
  concept: string;
  /** The concept's own CWE anchors (report traceability, same shape as
   *  packet/index.ts's ConceptMapping.cwe). */
  cwe: number[];
  /** Which of the concept's terms were actually found in the index —
   *  evidence for why this concept was judged present. */
  matchedTerms: string[];
}

// Cap on how many chunk hits per concept are pulled back for the
// matched-terms substring scan below. Presence itself only needs
// hits.length > 0; a handful is plenty to report a few real matched terms
// without over-fetching on a large index.
const PRESENCE_SEARCH_LIMIT = 5;

// loadOntology() re-parses ontology/concepts.yaml from disk on every call
// (see ontology/index.ts — its own default-ontology cache is private to that
// module). Cache it here too, same rationale as packet/index.ts's
// cachedOntology: coverageGaps() with no explicit ontology walks every
// concept, so repeated calls in one process shouldn't re-read/re-parse the
// YAML each time.
let cachedOntology: Ontology | undefined;

function defaultOntology(): Ontology {
  if (!cachedOntology) cachedOntology = loadOntology();
  return cachedOntology;
}

/**
 * Is `concept` present in the index? Reuses the same FTS store (and the same
 * toFtsQuery OR-of-terms shape) query.ts's Tier-1 pipeline already builds
 * from expand() output — a concept is "present" here in exactly the sense
 * expand() would surface it from free text. Returns which of the concept's
 * own terms literally appear (case-insensitive substring) in the matched
 * chunks, for reporting.
 */
function conceptPresence(
  db: CodeSearchDb,
  concept: OntologyConcept,
): { present: boolean; matchedTerms: string[] } {
  const ftsQuery = toFtsQuery([concept.key, ...concept.terms].join(" "));
  if (!ftsQuery) return { present: false, matchedTerms: [] };

  const hits = db.searchFts(ftsQuery, PRESENCE_SEARCH_LIMIT);
  if (hits.length === 0) return { present: false, matchedTerms: [] };

  const haystack = hits.map((h) => h.chunkText.toLowerCase()).join("\n");
  const matchedTerms = concept.terms.filter((t) =>
    haystack.includes(t.toLowerCase()),
  );
  return { present: true, matchedTerms };
}

/**
 * Does any finding cover `concept`? Either a direct concept-key match
 * (finding.concept === concept.key) or a CWE overlap (finding.cwe intersects
 * concept.cwe) — a rule that fired on the same CWE anchor counts even if its
 * metadata.concept wasn't set.
 */
function isCovered(
  concept: OntologyConcept,
  coveredConcepts: Set<string>,
  coveredCwe: Set<number>,
): boolean {
  if (coveredConcepts.has(concept.key)) return true;
  return concept.cwe.some((c) => coveredCwe.has(c));
}

/**
 * The escalation signal itself: ontology concepts present in the index but
 * with no rule-pack finding covering them. `ontology` defaults to the
 * cached `ontology/concepts.yaml` (see defaultOntology() above); pass an
 * explicit one (e.g. from `parseOntology`) in tests.
 */
export function coverageGaps(
  db: CodeSearchDb,
  findings: Finding[],
  ontology: Ontology = defaultOntology(),
): CoverageGap[] {
  const coveredConcepts = new Set<string>();
  const coveredCwe = new Set<number>();
  for (const f of findings) {
    if (f.concept) coveredConcepts.add(f.concept);
    for (const c of f.cwe ?? []) coveredCwe.add(c);
  }

  const gaps: CoverageGap[] = [];
  for (const concept of ontology.concepts) {
    const { present, matchedTerms } = conceptPresence(db, concept);
    if (!present) continue;
    if (isCovered(concept, coveredConcepts, coveredCwe)) continue;
    gaps.push({ concept: concept.key, cwe: concept.cwe, matchedTerms });
  }
  return gaps;
}
