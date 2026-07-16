# Lodestone — design (extraction of bpm-code-search-mcp into a standalone product)

Status: DESIGN, 2026-07-16. Decided by Brad: the code-search engine becomes its own bpmforge product because it's consumed across CodeReckon, RepoPulse, and the expert system.

> **Name.** *Lodestone* — the naturally magnetized rock early compasses were cut from; it finds true north. Find-by-meaning, mining/forge-adjacent, sits with Kryptkeeper / Shipwright / RepoPulse. Repo: `bpmforge/lodestone`. Alternates if it clashes: Dowser, Assay.

## 1. What it is

A CPU-only code index + retrieval engine. Given a repo snapshot it builds one portable SQLite artifact and answers three question shapes with **zero LLM calls**:

- **Lexical / structural** — "find `AKIA` literals", "every `catch` with an empty body" (regex + AST).
- **Symbolic** — "who calls `UserService.authenticate`", "is `parseToken` exported-but-unused" (defs/refs/calls/imports graph).
- **Semantic-ish** — "where is password handling", "find rate limiting" (BM25F over identifiers + subtokens + vector kNN + concept-ontology expansion, fused with RRF, clustered by call graph).

It is the **Tier-1 retrieval layer** in the CPU-first pipeline: it makes the LLM tier cheap by handing it small, high-precision evidence packets instead of whole files.

## 2. Why extract now

`bpm-code-search-mcp` v0.4 already ships the hard parts: hybrid BM25+vector RRF, sqlite-vec ANN with FTS fallback, 10-language symbol extraction, provider-sticky embeddings, line-level references. Three products are about to depend on it. Extracting once and adding the missing pieces (BM25F fields, ontology expansion, evidence-packet builder, CLI + library API alongside the MCP server) is cheaper than each product reimplementing retrieval.

`bpm-code-search-mcp` stays as a thin MCP wrapper re-exporting Lodestone's core, so the expert-system install path is unchanged.

## 3. Packaging

Three consumption surfaces over one core:

| Surface | Consumer | Form |
|---|---|---|
| **Library** (`@bpmforge/lodestone`) | CodeReckon, RepoPulse scanners | `index(snapshotDir) → LodestoneDB`; `query(db, q) → Cluster[]`; `evidencePacket(db, finding) → Packet` |
| **CLI** (`lodestone`) | CI, sandbox scanners, ad-hoc audits | `lodestone index <dir>`, `lodestone search "<q>"`, `lodestone packet <finding.json>` |
| **MCP server** (`lodestone-mcp`) | Claude Code / opencode (via existing `code-search` name) | current tool set: `code_index`, `code_search`, `code_symbols`, `code_outline`, `code_references`, `code_index_status` |

## 4. Index artifacts (one SQLite file per snapshot + optional Lance dir)

1. **chunks** — tree-sitter, cAST-style split-then-merge at function/method granularity (~1–1.5k token budget), header = `path + enclosing symbol chain`. (cAST, EMNLP 2025: +4.3 Recall@5 over sliding-window chunking.) Replaces the current fixed 60-line window.
2. **fts (BM25F)** — three weighted columns: `symbols` (raw identifiers, high weight) / `subtokens` (camelCase/snake split, mid) / `body` (comments+strings, low). Identifier splitting is the cheapest semantic trick — `validateUserPassword` matches "password validation" with no model. (Sourcegraph BM25F: ~20% ranking win, zero ML.) Upgrade from today's plain FTS5.
3. **vectors** (flag-gated, still zero marginal cost) — sqlite-vec, 256-dim Matryoshka-truncated. Embedder: **CodeRankEmbed (137M, MIT)** on server CPU; **jina-code-embeddings-0.5b GGUF** via llama.cpp/Metal on M-series (same binary path both platforms). Both beat the current `nomic-embed-text` decisively on NL→code — switching the default code embedder is the single highest-leverage quality upgrade.
4. **symbols** — `defs(symbol,path,range,kind)`, `refs`, `calls(caller,callee)`, `imports(from,to)`. tree-sitter tags is the sandbox default (works under `--network=none`); SCIP indexers (Apache-2.0: scip-typescript/python/go/java, rust-analyzer) used when deps can be vendored, for compiler-accurate cross-file resolution. GitHub stack-graphs was archived Sep 2025 — SCIP is the only maintained precise option.
5. **ontology** — the curated CWE/OWASP concept map (seeded at `codereckon/docs/research/concept-ontology-seed.yaml`, moves here). Versioned asset. Doubles as a **coverage signal**: concept present in the index but no rule-pack finding → a deterministic reason to escalate to the LLM tier.

Indexing cost is dominated by embedding: 137M on 8 CPU cores ≈ 50–200 chunks/s → a 100k-LOC repo in low minutes; faster on M-series Metal.

## 5. Query pipeline (no LLM)

```
query "where is password handling"
  → ontology.expand(q)                     # → {passwd, pwd, bcrypt, argon2, hash, salt, credential, login, ...}
  → parallel:
      BM25F(expanded, symbols-boosted)
      vector.kNN(original NL query)         # prefix-instructed
      exact-identifier hits
  → RRF(k=60)
  → rank adjust: +definitions, −test/vendored/generated, +complete-token, +import-graph centrality
  → graph.expand(top-N, 1 hop callers+callees+same-symbol refs)
  → Cluster[]  (primary site + neighbors + config refs, each with path:line)
```

The graph-expansion / clustering step is what makes it feel LLM-like: it returns "password handling lives in `auth/hash.ts`, called from `routes/login.ts`, config in `security.yml`" rather than a flat hit list.

## 6. Evidence-packet builder (the token-cost lever)

`evidencePacket(db, finding)` → a few-KB bundle: the finding's chunk + its call-graph neighborhood + relevant config + the concept it maps to. This is what the LLM tier consumes instead of files. Retrieval quality directly caps token spend; the packet is the contract between Tier 1 (deterministic) and Tier 2/3 (LLM).

## 7. In-house ladder (decision 6)

Lodestone's AST + index make several external tools cheap to replace over time, all behind the same output schema:
- complexity metrics (retire lizard — cyclomatic count over the tree-sitter AST is small),
- token-based duplication (retire jscpd — Rabin-Karp over the chunk token stream),
- dead-export/ref detection (retire knip-class tools — query the symbol graph).

Kept external, adapter-wrapped: tree-sitter + grammars (MIT, foundational), the embedder runtime (llama.cpp/ONNX), SCIP indexers, sqlite-vec. These aren't worth rewriting.

## 8. Extraction plan

1. New repo `bpmforge/lodestone`, both remotes; move `src/{chunker,db,embeddings,indexer,search,symbols}` in as `core/`.
2. Add BM25F columns to the FTS schema; add subtoken splitter.
3. Add `ontology/` loader + `expand()`; import the seed YAML.
4. Add `evidencePacket()`.
5. Add CLI (`bin/lodestone`) over the same core.
6. Swap default code embedder to CodeRankEmbed (keep provider-sticky guard).
7. Republish `bpm-code-search-mcp` as a thin dependency on `@bpmforge/lodestone` (MCP surface unchanged; expert-system install path untouched).
8. CodeReckon + RepoPulse depend on the library; RepoPulse registers it as a `Scanner` with `inputs:'snapshot'`.

Public posture: MIT-licensed engine is defensible (like the tools it wraps); the **ontology + proprietary rule packs stay closed** — that's the moat, not the search code.
