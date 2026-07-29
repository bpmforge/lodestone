/**
 * Lodestone library entry point — the barrel a consumer imports:
 *
 *   import { query, evidencePacket, coverageGaps, indexPath, CodeSearchDb, ontology }
 *     from "@bpmforge/lodestone";
 *
 * Pure re-exports only — importing this module has NO side effects (no DB
 * connection, no MCP transport, no server start, no network call). Safe to
 * import from any process, including one that never touches MCP.
 *
 * See `src/mcp.ts` for the MCP stdio server entry point (the `lodestone-mcp`
 * / `bpm-code-search-mcp` bin) — that file both defines and starts the
 * server, and connecting the transport IS a side effect on import, which is
 * exactly why it is not this file.
 */

// --- Tier-1 retrieval (docs/LODESTONE_DESIGN.md §5) -----------------------
export { query } from "./search/query.js";
export type {
  QueryOptions,
  Cluster,
  ClusterPrimary,
  ClusterNeighbor,
  NeighborRelation as QueryNeighborRelation,
} from "./search/query.js";

// --- Evidence packets (docs/LODESTONE_DESIGN.md §6) ------------------------
export { evidencePacket } from "./packet/index.js";
export type {
  Finding,
  EvidenceChunk,
  EvidencePacket,
  CallGraphNeighbor,
  ConfigRef,
  ConceptMapping,
  NeighborRelation as PacketNeighborRelation,
} from "./packet/index.js";

// --- Coverage-gap escalation signal (docs/LODESTONE_DESIGN.md §6 follow-on) -
export { coverageGaps } from "./packet/coverage.js";
export type { CoverageGap } from "./packet/coverage.js";

// --- Indexing ---------------------------------------------------------------
export { indexPath } from "./indexer.js";
export type { IndexResult } from "./indexer.js";

// --- Storage ------------------------------------------------------------
export { CodeSearchDb } from "./db.js";
export type { Chunk, SearchResult, SymbolRow } from "./db.js";

// --- Concept ontology (CWE/OWASP keyword map, zero-LLM query expansion) ---
export * as ontology from "./ontology/index.js";

// --- Embedding providers (needed to drive indexPath / query yourself) -----
export { detectProvider, providerFromMeta } from "./embeddings/index.js";
export type { EmbeddingProvider, ProviderMeta } from "./embeddings/index.js";

// --- Native metrics (W7-01/W7-02: retire lizard/jscpd/knip) ----------------
export {
  computeComplexity,
  SUPPORTED_LANGUAGES,
} from "./metrics/complexity.js";
export type { FunctionComplexity } from "./metrics/complexity.js";
export { computeDuplication } from "./metrics/duplication.js";
export type {
  CloneGroup,
  CloneOccurrence,
  DuplicationOptions,
} from "./metrics/duplication.js";
export { computeDeadCode } from "./metrics/deadCode.js";
export type { DeadCodeFinding, DeadCodeOptions } from "./metrics/deadCode.js";

// --- Symbol-graph-driven ANTI_SLOP detectors (W3-10) ------------------------
export { computeSingleImplementation } from "./metrics/singleImplementation.js";
export type { SingleImplementationFinding } from "./metrics/singleImplementation.js";
export { computeSingleUseHelper } from "./metrics/singleUseHelper.js";
export type {
  SingleUseHelperFinding,
  SingleUseHelperOptions,
} from "./metrics/singleUseHelper.js";
export { computePhantomImports } from "./metrics/phantomImports.js";
export type { PhantomImportFinding } from "./metrics/phantomImports.js";

// --- Tier-1 symbol-graph detectors (health-detectors ticket) ------------
export { computeUntestedSurface } from "./metrics/untestedSurface.js";
export type {
  UntestedSurfaceFinding,
  UntestedSurfaceOptions,
} from "./metrics/untestedSurface.js";
export {
  computeDependencyCycles,
  buildResolvedImportGraph,
} from "./metrics/dependencyCycles.js";
export type { DependencyCycleFinding } from "./metrics/dependencyCycles.js";
export { computeCouplingOutliers } from "./metrics/couplingOutliers.js";
export type {
  CouplingOutlierFinding,
  CouplingOutlierOptions,
} from "./metrics/couplingOutliers.js";
