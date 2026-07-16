import type { SearchResult } from "./db.js";

/** Escape a string for use as a literal inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RefLine {
  filePath: string;
  line: number; // absolute, 1-based
  isDef: boolean;
  context: string; // formatted ±context lines, the ref line marked with '>'
}

/**
 * Turn FTS chunk hits into line-level references.
 *
 * The old code_references dumped the whole 60-line chunk for every hit — noisy
 * and token-heavy. This extracts only the lines that actually mention `name`
 * (word-boundary match), each with ±contextLines of surrounding code and a
 * [def]/[use] tag (def = the line matches a symbol definition in `defKeys`, a
 * set of "filePath:line"). Overlapping chunks (the chunker overlaps 15 lines)
 * are de-duped so the same physical line isn't reported twice.
 */
export function extractRefLines(
  results: SearchResult[],
  name: string,
  defKeys: Set<string>,
  opts: { maxRefs?: number; contextLines?: number } = {},
): { refs: RefLine[]; truncated: boolean } {
  const maxRefs = opts.maxRefs ?? 30;
  const ctx = opts.contextLines ?? 2;
  const re = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const refs: RefLine[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    const lines = r.chunkText.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      const absLine = r.startLine + i;
      const key = `${r.filePath}:${absLine}`;
      if (seen.has(key)) continue; // de-dup overlapping chunks
      seen.add(key);

      const from = Math.max(0, i - ctx);
      const to = Math.min(lines.length - 1, i + ctx);
      const context = lines
        .slice(from, to + 1)
        .map((l, k) => {
          const ln = r.startLine + from + k;
          const marker = from + k === i ? ">" : " ";
          return `${String(ln).padStart(5)} ${marker} ${l}`;
        })
        .join("\n");

      refs.push({
        filePath: r.filePath,
        line: absLine,
        isDef: defKeys.has(key),
        context,
      });
      if (refs.length >= maxRefs) return { refs, truncated: true };
    }
  }
  return { refs, truncated: false };
}

/** Render the extracted reference lines for the tool response. */
export function formatRefLines(
  name: string,
  refs: RefLine[],
  truncated: boolean,
): string {
  if (refs.length === 0) {
    return `No references found for "${name}". Check spelling, or try code_search for a semantic search.`;
  }
  const defs = refs.filter((r) => r.isDef).length;
  const header =
    `References to "${name}" — ${refs.length} line(s)` +
    (defs ? `, ${defs} definition(s)` : "") +
    (truncated ? " (truncated — raise top_k or add a path_filter)" : "") +
    ":";
  const blocks = refs.map(
    (r) => `${r.filePath}:${r.line} [${r.isDef ? "def" : "use"}]\n${r.context}`,
  );
  return `${header}\n\n${blocks.join("\n\n")}`;
}

/**
 * Cap a chunk to at most maxLines for display, noting how many were elided.
 * Semantic search returns whole chunks; a very long chunk shouldn't flood the
 * caller — the file:line header lets them open the full source when needed.
 */
export function snippet(text: string, maxLines = 24): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const shown = lines.slice(0, maxLines).join("\n");
  return `${shown}\n… (${lines.length - maxLines} more line(s) — open the file for the rest)`;
}
