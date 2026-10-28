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

## Embeddings

Lodestone's semantic ranking needs one embedding provider, served locally
(no cloud calls, no per-embedding cost). `detectProvider()` picks the first
one it finds available, in this priority order:

1. **CodeRankEmbed** (default) — [`nomic-ai/CodeRankEmbed`](https://huggingface.co/nomic-ai/CodeRankEmbed), 137M params, MIT. A code-specialized embedder that beats general text embedders (e.g. nomic-embed-text) on NL→code retrieval — the exact query shape Lodestone answers ("where is password handling", "find rate limiting").
2. **nomic-embed-text** (fallback / explicit opt-in) — `text-embedding-nomic-embed-text-v1.5`, general-purpose text embedder. Still selectable if CodeRankEmbed isn't loaded.

Both are served the same way: LM Studio's OpenAI-compatible `/v1/embeddings`
endpoint on `localhost:1234`. The server base URL and nomic-embed-text's
model id are overridable via `LM_STUDIO_URL` / `LM_STUDIO_MODEL` env vars
in `src/mcp.ts`; CodeRankEmbed's model id/dim are overridable only through
`detectProvider({ codeRankModel })` / library constructor options today —
`mcp.ts` env wiring for the CodeRankEmbed model id is deferred (out of
W3-07's scope, `src/embeddings/**` only). `detectProvider()` checks which
specific model id is actually loaded before selecting it, so a
running-but-wrong-model LM Studio instance doesn't get picked and then fail
at embed time.

**Provider-sticky guard.** The provider that built an index is recorded in
its metadata (`name` + `dim`) and MUST match at query time — Lodestone
never mixes vector spaces from two different embedders. `coderank-embed`
and `lm-studio` are distinct provider names (even though both currently
embed at 768 dimensions) specifically so switching the default trips this
guard: a query against an index built with the other provider degrades
cleanly to FTS5/BM25 keyword search instead of scoring nonsense vector
similarity. Re-index (`code_index` / `indexPath()`) to rebuild with the new
provider.

To select the fallback yourself: point LM Studio at
`text-embedding-nomic-embed-text-v1.5` only (don't load CodeRankEmbed), or
construct `LmStudioProvider` directly via the library API
(`import { LmStudioProvider } from "@bpmforge/lodestone"`, exposed via
`detectProvider`/`providerFromMeta` in `src/embeddings/index.ts`).

> **Status:** CodeRankEmbed's default wiring, selection logic, and the
> provider-sticky guard are implemented and unit-tested against a mocked
> LM Studio (`src/tests/embeddings.test.ts`) — no model download was
> available in the environment this was built in. Before trusting a live
> index, verify **all** of: (1) LM Studio's model catalog actually has a
> CodeRankEmbed GGUF to load — if not, `CodeRankEmbedProvider`'s
> LM-Studio-backed approach doesn't apply and the provider needs an
> ONNX/transformers.js-on-CPU implementation instead (same
> `EmbeddingProvider` interface, swap the constructor in
> `src/embeddings/index.ts`); (2) the exact model id string LM Studio
> exposes it as (`text-embedding-coderankembed` here is a guess); (3) the
> real embedding dimension (assumed 768). CodeRankEmbed's model card also
> documents an asymmetric query
> instruction prefix ("Represent this query for searching relevant code:
> ") that Lodestone's symmetric `embed()` interface does not yet apply —
> retrieval works without it but may not hit the model's benchmarked
> numbers until that's wired into the query path (same pre-existing gap
> applies to nomic-embed-text).

## Consumers

- **`bpm-code-search-mcp`** — the MCP server for Claude Code / opencode (re-exports Lodestone's MCP surface; tool names unchanged).
- **CodeReckon / RepoPulse** — Tier-1 retrieval + evidence packets feeding the deterministic-first, LLM-only-for-synthesis pipeline.

## Status

Extracted from `bpm-code-search-mcp` (2026-07-16). The engine + MCP server live here; a standalone `lodestone` CLI and the thin `bpm-code-search-mcp` wrapper follow (W3-08). Build: `npm run build` · Test: `npm test`.

## License

MIT, including the security concept ontology (owner decision 2026-10-28, which reversed the 2026-07-28 decision to keep Lodestone private: it now ships inside an open-source RepoPulse, and the bpm-rulepacks rules are MIT too).
