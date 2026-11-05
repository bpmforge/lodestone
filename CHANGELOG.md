# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning [SemVer](https://semver.org/).

## [Unreleased]

- **`@bpmforge/lodestone/graph` entry**: `extractGraph`, `languageForPath`, `EXT_TO_LANG` and `isCrossFileGraphReliable` with no SQLite, no sqlite-vec and no MCP SDK in their import graph (`graph-entry.test.ts` walks it). For consumers that store the graph themselves, such as RepoPulse's per-scan code index.
- **Packaging**: `files` limits the package to `dist`, `ontology` and the docs (62 kB packed); `better-sqlite3`, `sqlite-vec`, `@modelcontextprotocol/sdk` and `zod` are optional peer dependencies (and dev dependencies here), so a graph-only consumer installs no native addon. The full library and the MCP server still need them installed.

## [0.1.0] — 2026-07-16

Initial extraction from `bpm-code-search-mcp`. Lodestone becomes a standalone CPU-only code index + retrieval engine.

- **Engine**: cAST tree-sitter chunker (12 languages, window fallback), BM25F weighted FTS (symbols/subtokens/body) + identifier subtoken splitter, sqlite-vec vectors (provider-sticky), symbol graph (defs/refs/calls/imports).
- **Retrieval**: `query()` — ontology.expand → BM25F + vector kNN + exact → RRF(k=60) → rank-adjust → 1-hop graph cluster; `evidencePacket()` for the LLM tier.
- **Ontology**: 42 concepts (OWASP web + LLM Top-10, CWE Top-25) + `expand()`.
- **Eval**: golden retrieval harness — Recall@5=0.906, MRR=0.437, with a regression guard.
- 152 tests. MCP server retained (tool names unchanged). CLI + thin `bpm-code-search-mcp` wrapper to follow.
