import fs from "fs";
import path from "path";
import { glob } from "glob";
import { chunkFile } from "./chunker/index.js";
import { CodeSearchDb } from "./db.js";
import type { EmbeddingProvider } from "./embeddings/index.js";
import { extractSymbols } from "./symbols/extractor.js";
import { extractGraph } from "./symbols/graph.js";

const BATCH_SIZE = 32;

const DEFAULT_INCLUDE = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.py",
  "**/*.rs",
  "**/*.go",
  "**/*.java",
  "**/*.cs",
  "**/*.cpp",
  "**/*.c",
  "**/*.h",
  "**/*.rb",
  "**/*.php",
  "**/*.swift",
  "**/*.kt",
  "**/*.md",
  "**/*.mdx",
];

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  "**/*.min.js",
  "**/*.map",
];

export interface IndexResult {
  indexed: number;
  skipped: number;
  errors: string[];
}

export async function indexPath(
  rootPath: string,
  db: CodeSearchDb,
  provider: EmbeddingProvider,
  options: { include?: string[]; ignore?: string[] } = {},
): Promise<IndexResult> {
  const include = options.include ?? DEFAULT_INCLUDE;
  const ignore = options.ignore ?? DEFAULT_IGNORE;

  const files = await glob(include, {
    cwd: rootPath,
    ignore,
    absolute: true,
    nodir: true,
  });

  let indexed = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      const mtime = Math.floor(stat.mtimeMs);
      const stored = db.getFileMtime(filePath);

      if (stored === mtime) {
        skipped++;
        continue;
      }

      const content = fs.readFileSync(filePath, "utf-8");
      const chunks = await chunkFile(content, filePath);

      db.deleteFile(filePath);

      // Symbol extraction — runs for all indexed files regardless of chunk count
      const symbols = extractSymbols(content, filePath);
      if (symbols.length > 0) {
        db.insertSymbols(
          symbols.map((s) => ({ ...s, filePath, fileMtime: mtime })),
        );
      }

      // Symbol graph (defs/refs/calls/imports) — see docs/LODESTONE_DESIGN.md
      // §4 item 4. Additive: runs for all indexed files regardless of chunk
      // count, mirrors the symbols block above. Never crashes the indexer —
      // extractGraph() falls back to a regex tier internally and this is
      // still wrapped defensively.
      try {
        const graph = await extractGraph(content, filePath);
        if (graph.defs.length > 0) {
          db.insertDefs(graph.defs.map((d) => ({ ...d, fileMtime: mtime })));
        }
        if (graph.refs.length > 0) {
          db.insertRefs(graph.refs.map((r) => ({ ...r, fileMtime: mtime })));
        }
        if (graph.calls.length > 0) {
          db.insertCalls(graph.calls.map((c) => ({ ...c, fileMtime: mtime })));
        }
        if (graph.imports.length > 0) {
          db.insertImports(
            graph.imports.map((i) => ({ ...i, fileMtime: mtime })),
          );
        }
      } catch (err) {
        errors.push(
          `${filePath} (symbol graph): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (chunks.length === 0) {
        skipped++;
        continue;
      }

      // Embed in batches
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await provider.embed(batch.map((c) => c.text));

        db.insertChunks(
          batch.map((chunk, j) => ({
            filePath,
            chunkText: chunk.text,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            fileMtime: mtime,
            embeddingProvider: provider.name,
            embedding: new Float32Array(embeddings[j]),
            // Symbols declared within this chunk's line range populate the
            // FTS5 symbols/subtokens columns (BM25F weighting — see db.ts).
            symbols: symbols
              .filter(
                (s) => s.line >= chunk.startLine && s.line <= chunk.endLine,
              )
              .map((s) => s.name),
          })),
        );
      }

      indexed++;
    } catch (err) {
      errors.push(
        `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { indexed, skipped, errors };
}
