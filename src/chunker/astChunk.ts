import type { Node, Tree } from "web-tree-sitter";
import type { Chunk } from "./types.js";
import type { LangAdapter } from "./adapters.js";
import { estimateTokens, CHUNK_TOKEN_BUDGET } from "./tokenBudget.js";

function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function makeHeader(filePath: string, chain: string[]): string {
  return [filePath, ...chain].join(" > ");
}

/**
 * Unlike the window fallback (which drops slices under MIN_CHUNK_CHARS as
 * noise), AST chunks are already complete semantic units — a two-line
 * function is still a real, searchable chunk. Only drop truly empty text.
 */
function pushChunk(
  chunks: Chunk[],
  text: string,
  startLine: number,
  endLine: number,
  filePath: string,
  chain: string[],
): void {
  const trimmed = text.trim();
  if (trimmed.length === 0) return;
  chunks.push({
    text: trimmed,
    startLine,
    endLine,
    header: makeHeader(filePath, chain),
    symbolChain: chain,
  });
}

/**
 * A unit (function/method) whose full text fits the budget becomes one
 * chunk. An oversized unit is split at its body's statement boundaries
 * (cAST split step) — never below a statement, and never dropped: if the
 * body isn't a recognized block type (or has only one statement), it's
 * emitted whole even if over budget.
 */
function emitUnit(
  node: Node,
  chain: string[],
  filePath: string,
  adapter: LangAdapter,
): Chunk[] {
  const fullText = node.text;
  if (estimateTokens(fullText) <= CHUNK_TOKEN_BUDGET) {
    return withChunk(
      fullText,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      filePath,
      chain,
    );
  }

  const body = adapter.unwrap(node).childForFieldName("body");
  const bodyStatements =
    body && adapter.blockTypes.has(body.type) ? namedChildrenOf(body) : [];

  if (!body || bodyStatements.length <= 1) {
    // Can't split below a single statement — emit the whole (oversized) unit.
    return withChunk(
      fullText,
      node.startPosition.row + 1,
      node.endPosition.row + 1,
      filePath,
      chain,
    );
  }

  const signature = fullText.slice(0, body.startIndex - node.startIndex);
  const chunks: Chunk[] = [];
  let group: Node[] = [];
  let groupTokens = 0;
  let part = 1;

  const flush = () => {
    if (group.length === 0) return;
    const isFirst = part === 1;
    const text = isFirst
      ? `${signature}\n${group.map((n) => n.text).join("\n")}`
      : group.map((n) => n.text).join("\n");
    const startLine = isFirst
      ? node.startPosition.row + 1
      : group[0].startPosition.row + 1;
    const endLine = group[group.length - 1].endPosition.row + 1;
    const label =
      part === 1
        ? chain
        : [...chain.slice(0, -1), `${chain[chain.length - 1]} (part ${part})`];
    pushChunk(chunks, text, startLine, endLine, filePath, label);
    part++;
    group = [];
    groupTokens = 0;
  };

  for (const stmt of bodyStatements) {
    const stmtTokens = estimateTokens(stmt.text);
    if (group.length > 0 && groupTokens + stmtTokens > CHUNK_TOKEN_BUDGET) {
      flush();
    }
    group.push(stmt);
    groupTokens += stmtTokens;
  }
  flush();

  return chunks.length > 0
    ? chunks
    : withChunk(
        fullText,
        node.startPosition.row + 1,
        node.endPosition.row + 1,
        filePath,
        chain,
      );
}

function withChunk(
  text: string,
  startLine: number,
  endLine: number,
  filePath: string,
  chain: string[],
): Chunk[] {
  const chunks: Chunk[] = [];
  pushChunk(chunks, text, startLine, endLine, filePath, chain);
  return chunks;
}

/** Merge consecutive non-unit siblings (imports, top-level consts, stray
 *  statements) into budget-sized chunks — the cAST merge step. */
function flushFiller(
  filler: Node[],
  chain: string[],
  filePath: string,
  chunks: Chunk[],
): void {
  if (filler.length === 0) return;
  let group: Node[] = [];
  let groupTokens = 0;

  const flush = () => {
    if (group.length === 0) return;
    const text = group.map((n) => n.text).join("\n");
    const startLine = group[0].startPosition.row + 1;
    const endLine = group[group.length - 1].endPosition.row + 1;
    pushChunk(chunks, text, startLine, endLine, filePath, chain);
    group = [];
    groupTokens = 0;
  };

  for (const node of filler) {
    const tokens = estimateTokens(node.text);
    if (group.length > 0 && groupTokens + tokens > CHUNK_TOKEN_BUDGET) {
      flush();
    }
    group.push(node);
    groupTokens += tokens;
  }
  flush();
}

function collectChunks(
  siblings: Node[],
  chain: string[],
  filePath: string,
  adapter: LangAdapter,
): Chunk[] {
  const chunks: Chunk[] = [];
  let filler: Node[] = [];

  for (const node of siblings) {
    const cls = adapter.classify(node);
    if (!cls) {
      filler.push(node);
      continue;
    }
    flushFiller(filler, chain, filePath, chunks);
    filler = [];

    if (cls.kind === "container") {
      const newChain = [...chain, cls.label];
      const body = adapter.unwrap(node).childForFieldName("body");
      const nested = body
        ? collectChunks(namedChildrenOf(body), newChain, filePath, adapter)
        : [];
      if (nested.length > 0) {
        chunks.push(...nested);
      } else {
        // Empty container (no members, or none tree-sitter recognizes) —
        // still worth a chunk so the container itself is searchable.
        chunks.push(
          ...withChunk(
            node.text,
            node.startPosition.row + 1,
            node.endPosition.row + 1,
            filePath,
            newChain,
          ),
        );
      }
    } else {
      const unitChain = [...chain, ...(cls.extraChain ?? []), cls.label];
      chunks.push(...emitUnit(node, unitChain, filePath, adapter));
    }
  }
  flushFiller(filler, chain, filePath, chunks);

  return chunks;
}

export function chunkTree(
  tree: Tree,
  filePath: string,
  adapter: LangAdapter,
): Chunk[] {
  return collectChunks(namedChildrenOf(tree.rootNode), [], filePath, adapter);
}
