#!/usr/bin/env node
import path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CodeSearchDb } from "./db.js";
import { detectProvider } from "./embeddings/index.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { indexPath } from "./indexer.js";
import { search } from "./search.js";
import { extractRefLines, formatRefLines, snippet } from "./format.js";

const ROOT = process.env.CODE_SEARCH_ROOT ?? process.cwd();
const DB_PATH = path.join(ROOT, ".code-search", "index.db");
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? "http://localhost:1234";
const LM_STUDIO_MODEL =
  process.env.LM_STUDIO_MODEL ?? "text-embedding-nomic-embed-text-v1.5";

const db = new CodeSearchDb(DB_PATH);
let provider: EmbeddingProvider | null = null;

async function getProvider(): Promise<EmbeddingProvider | null> {
  if (provider) return provider;
  try {
    provider = await detectProvider({
      lmStudioUrl: LM_STUDIO_URL,
      lmStudioModel: LM_STUDIO_MODEL,
    });
    const meta = db.getProviderMeta();
    if (!meta) {
      db.setProviderMeta({ name: provider.name, dim: provider.dim });
    } else if (meta.name !== provider.name || meta.dim !== provider.dim) {
      // Provider changed since last index — require re-index
      provider = null;
      return null;
    }
  } catch {
    provider = null;
  }
  return provider;
}

const server = new McpServer({ name: "bpm-code-search-mcp", version: "0.2.0" });

// ─── Semantic search ──────────────────────────────────────────────────────────

server.tool(
  "code_search",
  "Hybrid search over the codebase — fuses semantic (vector) and keyword (BM25) ranking so it finds both meaning and exact identifiers. Returns the most relevant code chunks with file paths and line numbers.",
  {
    query: z
      .string()
      .describe(
        'Natural language or code query (e.g. "HANDOFF confidence scoring", "auth middleware", "cosine similarity")',
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(10)
      .describe("Number of results to return (default 10)"),
    path_filter: z
      .string()
      .optional()
      .describe(
        'Only return results whose file path contains this string (e.g. "src/auth", ".md")',
      ),
  },
  async ({ query, top_k, path_filter }) => {
    try {
      const p = await getProvider();
      if (db.chunkCount() === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Index is empty. Run code_index first to index the codebase.",
            },
          ],
        };
      }

      const results = await search(query, db, p, {
        topK: top_k,
        pathFilter: path_filter,
      });

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No results found." }],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `[${i + 1}] ${r.filePath}:${r.startLine}-${r.endLine} (score: ${r.score.toFixed(3)})\n\`\`\`\n${snippet(r.chunkText)}\n\`\`\``,
        )
        .join("\n\n");

      return { content: [{ type: "text" as const, text: formatted }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─── Indexing ─────────────────────────────────────────────────────────────────

server.tool(
  "code_index",
  "Index or re-index the codebase for semantic search and symbol lookup. Run once after cloning a repo, then again when many files change. Skips files unchanged since last index.",
  {
    path: z
      .string()
      .optional()
      .describe(
        "Subdirectory to index (relative to project root). Omit to index the entire project.",
      ),
    force: z
      .boolean()
      .optional()
      .default(false)
      .describe("Force re-index all files, ignoring mtime cache"),
  },
  async ({ path: subPath, force }) => {
    try {
      const p = await getProvider();
      if (!p) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No embedding provider available. Start LM Studio with a text embedding model loaded (default: text-embedding-nomic-embed-text-v1.5 on localhost:1234) then retry.",
            },
          ],
          isError: true,
        };
      }

      const targetPath = subPath ? path.resolve(ROOT, subPath) : ROOT;

      if (force) {
        db.close();
        const freshDb = new CodeSearchDb(DB_PATH);
        Object.assign(db, freshDb);
        db.setProviderMeta({ name: p.name, dim: p.dim });
      }

      const result = await indexPath(targetPath, db, p);
      const summary = [
        `Indexed ${result.indexed} file(s), skipped ${result.skipped} unchanged.`,
        `Total: ${db.fileCount()} files, ${db.chunkCount()} chunks, ${db.symbolCount()} symbols in index.`,
        result.errors.length > 0
          ? `Errors (${result.errors.length}):\n${result.errors.slice(0, 5).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Index error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "code_index_status",
  "Check the current state of the code search index.",
  {},
  async () => {
    const meta = db.getProviderMeta();
    const chunks = db.chunkCount();
    const files = db.fileCount();
    const symbols = db.symbolCount();
    const status = meta
      ? `Provider: ${meta.name} (dim=${meta.dim})\nFiles: ${files}\nChunks: ${chunks}\nSymbols: ${symbols}\nIndex: ${DB_PATH}`
      : `No index yet. Run code_index to build it.\nIndex location: ${DB_PATH}`;
    return { content: [{ type: "text" as const, text: status }] };
  },
);

// ─── Symbol index ─────────────────────────────────────────────────────────────

server.tool(
  "code_symbols",
  "Browse the structural symbol index — list functions, classes, interfaces, types, enums, and other named constructs extracted from the codebase. Faster than semantic search for 'what exists' questions.",
  {
    kind: z
      .enum([
        "function",
        "class",
        "interface",
        "type",
        "enum",
        "const",
        "method",
        "struct",
        "trait",
        "impl",
        "section",
      ])
      .optional()
      .describe(
        "Filter by symbol kind (e.g. 'class', 'function', 'interface'). Omit for all kinds.",
      ),
    name_filter: z
      .string()
      .optional()
      .describe(
        "Partial name match (case-insensitive). E.g. 'Auth' returns AuthService, authenticate, etc.",
      ),
    path_filter: z
      .string()
      .optional()
      .describe(
        "Only show symbols from files whose path contains this string.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .default(100)
      .describe("Max symbols to return (default 100)."),
  },
  async ({ kind, name_filter, path_filter, limit }) => {
    try {
      if (db.symbolCount() === 0) {
        const hint =
          db.fileCount() > 0
            ? "Symbol index is empty but chunks exist — run code_index to rebuild (symbols are extracted during indexing)."
            : "Index is empty. Run code_index first.";
        return { content: [{ type: "text" as const, text: hint }] };
      }

      const rows = db.querySymbols({
        kind,
        name: name_filter,
        pathFilter: path_filter,
        limit,
      });

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No symbols match the given filters.",
            },
          ],
        };
      }

      // Group by file for readable output
      const byFile = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byFile.get(r.filePath) ?? [];
        list.push(r);
        byFile.set(r.filePath, list);
      }

      const lines: string[] = [`Found ${rows.length} symbol(s):\n`];
      for (const [file, syms] of byFile) {
        lines.push(`${file}`);
        for (const s of syms) {
          lines.push(
            `  ${s.line.toString().padStart(4)}  [${s.kind.padEnd(9)}]  ${s.name}`,
          );
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Symbol query error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "code_outline",
  "Show the structural outline of a file — all named symbols in order. Useful for understanding a file's API surface at a glance.",
  {
    file_path: z
      .string()
      .describe(
        "File path or partial path to outline (e.g. 'src/auth.ts', 'auth', 'routes/user'). Matches all files whose path contains this string.",
      ),
  },
  async ({ file_path }) => {
    try {
      const rows = db.getFileOutline(file_path);

      if (rows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No symbols found for path filter "${file_path}". Try a shorter path fragment or run code_index if the file is new.`,
            },
          ],
        };
      }

      // Group by file (path_filter might match multiple files)
      const byFile = new Map<string, typeof rows>();
      for (const r of rows) {
        const list = byFile.get(r.filePath) ?? [];
        list.push(r);
        byFile.set(r.filePath, list);
      }

      const out: string[] = [];
      for (const [file, syms] of byFile) {
        out.push(`\n── ${file} ──`);
        for (const s of syms) {
          const kindTag = `[${s.kind}]`.padEnd(11);
          out.push(`  ${String(s.line).padStart(4)}  ${kindTag}  ${s.name}`);
          if (s.signature.trim() !== s.name) {
            out.push(`         ${s.signature.trim()}`);
          }
        }
      }

      return { content: [{ type: "text" as const, text: out.join("\n") }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Outline error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "code_references",
  "Find all code chunks that reference (mention) a specific symbol name. Useful for tracing where a function, class, or type is used across the codebase.",
  {
    name: z
      .string()
      .describe(
        "Exact symbol name to find references for (e.g. 'authenticate', 'UserService').",
      ),
    top_k: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe("Max results (default 20)."),
    path_filter: z
      .string()
      .optional()
      .describe(
        "Only show references from files whose path contains this string.",
      ),
  },
  async ({ name, top_k, path_filter }) => {
    try {
      if (db.chunkCount() === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Index is empty. Run code_index first.",
            },
          ],
        };
      }

      // Over-fetch chunks that mention the name (FTS), then extract the actual
      // referencing LINES from them rather than dumping whole chunks.
      let hits = db.searchFtsForName(name, top_k * 3);
      if (path_filter) {
        hits = hits.filter((r) => r.filePath.includes(path_filter));
      }

      // Which lines are the symbol's own definition? Tag [def] vs [use].
      const defKeys = new Set(
        db
          .querySymbols({ name, limit: 300 })
          .filter((s) => s.name === name)
          .map((s) => `${s.filePath}:${s.line}`),
      );

      const { refs, truncated } = extractRefLines(hits, name, defKeys, {
        maxRefs: top_k,
        contextLines: 2,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatRefLines(name, refs, truncated),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `References error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
