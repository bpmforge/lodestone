/**
 * Lodestone graph entry point: the symbol graph alone, for a consumer that
 * stores the graph itself (RepoPulse persists names, spans and edges in its
 * own Postgres) and has no use for the SQLite index, embeddings or MCP:
 *
 *   import { extractGraph, isCrossFileGraphReliable } from "@bpmforge/lodestone/graph";
 *
 * Its whole import graph is web-tree-sitter, tree-sitter-wasms and Node
 * built-ins: no better-sqlite3, no sqlite-vec, no MCP SDK (graph-entry.test.ts
 * holds it to that). Importing it has no side effects; the first
 * extractGraph() call loads the grammar it needs.
 */
export { extractGraph } from "./symbols/graph.js";
export type {
  DefRow,
  RefRow,
  CallRow,
  ImportRow,
  GraphExtraction,
} from "./symbols/graph.js";
export { languageForPath, EXT_TO_LANG } from "./chunker/languages.js";
export { isCrossFileGraphReliable } from "./search/graphReliability.js";
