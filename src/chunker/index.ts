import { windowChunk } from "./fallback.js";
import { languageForPath, loadLanguage, getParser } from "./languages.js";
import { ADAPTERS } from "./adapters.js";
import { chunkTree } from "./astChunk.js";
import type { Chunk } from "./types.js";

export type { Chunk } from "./types.js";

/**
 * cAST-style (split-then-merge) tree-sitter chunker: chunks at
 * function/method/class granularity, splits oversized nodes at statement
 * boundaries, merges tiny adjacent siblings (imports, consts) up to a
 * token budget. See docs/LODESTONE_DESIGN.md §4 item 1.
 *
 * `filePath` drives language detection (by extension) — without it, or for
 * an extension with no grammar wired up, or if anything in the tree-sitter
 * path throws, this falls back to the sliding-window chunker (fallback.ts)
 * so a file is never dropped and the indexer never crashes.
 */
export async function chunkFile(
  content: string,
  filePath?: string,
): Promise<Chunk[]> {
  if (content.trim().length === 0) return [];

  const langId = filePath ? languageForPath(filePath) : undefined;
  const adapter = langId ? ADAPTERS[langId] : undefined;
  if (!langId || !adapter) {
    return windowChunk(content);
  }

  try {
    const language = await loadLanguage(langId);
    if (!language) return windowChunk(content);

    const parser = await getParser(language);
    const tree = parser.parse(content);
    if (!tree) return windowChunk(content);

    const chunks = chunkTree(tree, filePath as string, adapter);
    return chunks.length > 0 ? chunks : windowChunk(content);
  } catch {
    return windowChunk(content);
  }
}
