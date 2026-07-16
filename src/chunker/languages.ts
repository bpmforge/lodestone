import path from "path";
import { createRequire } from "module";
import { Parser, Language } from "web-tree-sitter";

/**
 * Extension -> tree-sitter-wasms grammar id. Only languages we ship an
 * adapter for in astChunk.ts are listed here; anything else (swift, kt,
 * md, mdx, ...) has no grammar wired and falls back to the window chunker.
 * That's by design — see LODESTONE_DESIGN.md §4 item 1 and the fallback
 * contract in fallback.ts.
 */
export const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "c_sharp",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
};

export function languageForPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext];
}

const require = createRequire(import.meta.url);

let wasmDir: string | undefined;
function getWasmDir(): string {
  if (!wasmDir) {
    wasmDir = path.join(
      path.dirname(require.resolve("tree-sitter-wasms/package.json")),
      "out",
    );
  }
  return wasmDir;
}

let initPromise: Promise<void> | undefined;
function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

// Cache resolved languages (and permanent failures, so we don't retry a
// missing/broken grammar file on every subsequent file of that language).
const languageCache = new Map<string, Language | null>();

/**
 * Load (and cache) the tree-sitter Language for a grammar id. Returns null
 * — never throws — if the wasm can't be found or fails to load, so callers
 * can fall back to the window chunker instead of crashing the indexer.
 */
export async function loadLanguage(langId: string): Promise<Language | null> {
  if (languageCache.has(langId)) {
    return languageCache.get(langId)!;
  }
  try {
    await ensureParserInit();
    const wasmPath = path.join(getWasmDir(), `tree-sitter-${langId}.wasm`);
    const language = await Language.load(wasmPath);
    languageCache.set(langId, language);
    return language;
  } catch {
    languageCache.set(langId, null);
    return null;
  }
}

/**
 * A parser instance, language-switched per call. Safe to share because
 * indexPath() processes files sequentially (no concurrent parse calls).
 */
let sharedParser: Parser | undefined;
export async function getParser(language: Language): Promise<Parser> {
  await ensureParserInit();
  if (!sharedParser) {
    sharedParser = new Parser();
  }
  sharedParser.setLanguage(language);
  return sharedParser;
}
