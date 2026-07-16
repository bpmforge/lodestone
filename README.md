# Lodestone

**A CPU-only code index + retrieval engine.** Given a repo, Lodestone builds one portable SQLite artifact and answers three kinds of question with **zero LLM calls**:

- **Lexical / structural** — regex + AST (find literals, empty catches, sinks).
- **Symbolic** — who calls `X`, is `Y` exported-but-unused (defs/refs/calls/imports graph).
- **Semantic-ish** — "where is password handling", "find rate limiting" — BM25F over identifiers + subtokens + vector kNN + concept-ontology expansion, fused with RRF and clustered by call graph.

It is the retrieval layer that makes an LLM tier cheap: it hands the model small, high-precision **evidence packets** instead of whole files. Companion to the bpmforge rule packs — Lodestone finds and packages; the LLM only synthesizes and chains.

## What's inside

| Module | Role |
|---|---|
| `src/chunker/` | cAST tree-sitter chunking (12 languages, window fallback) — function-granular chunks with symbol-chain headers |
| `src/db.ts` | SQLite schema: chunks, BM25F FTS (symbols/subtokens/body weighted), vectors (sqlite-vec), symbol graph |
| `src/search/` | `query()` — ontology.expand → BM25F + vector kNN + exact → RRF(k=60) → rank-adjust → graph cluster |
| `src/symbols/` | defs/refs/calls/imports graph (tree-sitter tier + regex fallback) |
| `src/ontology/` | 42-concept CWE/OWASP map + `expand()` for zero-LLM query expansion |
| `src/packet/` | `evidencePacket()` — finding + call-graph neighbors + config refs + concept, each `path:line` |
| `eval/` | golden retrieval judgments + Recall@k/MRR regression harness |

Retrieval quality (golden harness): **Recall@5 = 0.906, MRR = 0.437**.

## Consumers

- **`bpm-code-search-mcp`** — the MCP server for Claude Code / opencode (re-exports Lodestone's MCP surface; tool names unchanged).
- **CodeReckon / RepoPulse** — Tier-1 retrieval + evidence packets feeding the deterministic-first, LLM-only-for-synthesis pipeline.

## Status

Extracted from `bpm-code-search-mcp` (2026-07-16). The engine + MCP server live here; a standalone `lodestone` CLI and the thin `bpm-code-search-mcp` wrapper follow (W3-08). Build: `npm run build` · Test: `npm test`.

## License

MIT — the engine is moat-neutral (like the tools it wraps). The proprietary rule packs and the security concept ontology's curation are the moat, not the search code.
