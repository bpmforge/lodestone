import type { Node, Tree } from "web-tree-sitter";
import {
  languageForPath,
  loadLanguage,
  getParser,
} from "../chunker/languages.js";
import { ADAPTERS, type LangAdapter } from "../chunker/adapters.js";
import { extractSymbols } from "./extractor.js";

/**
 * Symbol graph extraction — defs/refs/calls/imports (see
 * docs/LODESTONE_DESIGN.md §4 item 4). Populates the graph tables consumed
 * by "who calls X" / "is export Y unused" / import-map queries. Tier-1
 * retrieval (W3-06) will consume this; it is not wired into search here.
 *
 * Two extraction tiers, chosen per file, never throwing:
 *   1. tree-sitter (accurate) — reuses the chunker's parser/grammar setup
 *      (read-only import, chunker itself is untouched) plus the same
 *      container/unit ADAPTERS used for chunk headers, so defs line up with
 *      what the chunker calls a symbol. Full caller/callee/import
 *      resolution is verified for TypeScript/TSX/JavaScript and Python
 *      (grammar node-type fields checked live — see graph.test.ts); for the
 *      other 8 grammars (go, rust, java, c_sharp, ruby, php, c, cpp) only
 *      defs are tree-sitter-derived (same generic adapter walk), refs/calls
 *      /imports for those fall through to the regex tier below.
 *   2. regex (fallback) — reuses the existing extractSymbols() regex
 *      patterns for defs, plus a light whole-word scan for refs/calls so a
 *      grammarless language (swift, kt, md) or a parse failure still
 *      produces a (lower-fidelity) graph instead of an empty one.
 *
 * refs fidelity note: for the fully tree-sitter-verified languages
 * (ts/tsx/js/py) refs are a *global* name-based xref — every
 * identifier/type/property occurrence in a file is recorded regardless of
 * whether that file also defines the name, so `queryRefs("exportedFn")`
 * finds a call site in a different file. The regex tier's refs are
 * same-file-only (it only scans for names the current file itself defines)
 * — a cross-file-only usage of a def from a grammarless/parse-failed file
 * will look falsely unused. See HANDOFF note in the W3-04 ticket close.
 */

export interface DefRow {
  symbol: string;
  path: string;
  startLine: number;
  endLine: number;
  kind: string;
}

export interface RefRow {
  symbol: string;
  path: string;
  line: number;
}

export interface CallRow {
  caller: string;
  callee: string;
  path: string;
  line: number;
}

export interface ImportRow {
  fromPath: string;
  toPathOrModule: string;
  line: number;
}

export interface GraphExtraction {
  defs: DefRow[];
  refs: RefRow[];
  calls: CallRow[];
  imports: ImportRow[];
  /** Which tier produced this file's graph — see module doc above. */
  method: "tree-sitter" | "regex";
}

const EMPTY_GRAPH: Omit<GraphExtraction, "method"> = {
  defs: [],
  refs: [],
  calls: [],
  imports: [],
};

export async function extractGraph(
  content: string,
  filePath: string,
): Promise<GraphExtraction> {
  if (content.trim().length === 0) return { ...EMPTY_GRAPH, method: "regex" };

  const langId = languageForPath(filePath);
  const adapter = langId ? ADAPTERS[langId] : undefined;

  if (langId && adapter) {
    try {
      const language = await loadLanguage(langId);
      if (language) {
        const parser = await getParser(language);
        const tree = parser.parse(content);
        if (tree) {
          return extractFromTree(tree, filePath, langId, adapter);
        }
      }
    } catch {
      // Fall through to the regex tier — never crash the indexer.
    }
  }

  return extractFromRegex(content, filePath);
}

// --- Tree-sitter tier ------------------------------------------------------

function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

/**
 * Full-tree walk reusing the chunker's ADAPTERS.classify() so a def here is
 * the same node the chunker treats as a chunk-header symbol. Unlike the
 * chunker, this walks the *whole* tree (not just chunk boundaries) and
 * tracks container nesting to distinguish "function" from "method".
 */
function extractDefs(
  tree: Tree,
  filePath: string,
  adapter: LangAdapter,
): DefRow[] {
  const defs: DefRow[] = [];

  function walkChildren(node: Node, insideContainer: boolean): void {
    for (const child of namedChildrenOf(node)) walk(child, insideContainer);
  }

  function walk(node: Node, insideContainer: boolean): void {
    const cls = adapter.classify(node);
    if (!cls) {
      walkChildren(node, insideContainer);
      return;
    }

    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    // Walk from the *unwrapped* node's children, never the wrapper's — a
    // wrapper (e.g. TS/JS `export_statement`) has the unwrapped declaration
    // as its only child, and that child re-classifies to the same def; using
    // `node`'s children here would visit it a second time and double-count.
    const effective = adapter.unwrap(node);

    if (cls.kind === "container") {
      // label is "class Foo" / "interface Foo" / "impl Foo" / ... — kind is
      // the first word, symbol is the rest.
      const spaceIdx = cls.label.indexOf(" ");
      const kind = spaceIdx === -1 ? cls.label : cls.label.slice(0, spaceIdx);
      const symbol =
        spaceIdx === -1 ? cls.label : cls.label.slice(spaceIdx + 1);
      defs.push({ symbol, path: filePath, startLine, endLine, kind });

      const body = effective.childForFieldName("body");
      if (body) walkChildren(body, true);
      else walkChildren(effective, true);
    } else {
      defs.push({
        symbol: cls.label,
        path: filePath,
        startLine,
        endLine,
        kind: insideContainer ? "method" : "function",
      });
      walkChildren(effective, false);
    }
  }

  walkChildren(tree.rootNode, false);
  return defs;
}

/** Node types treated as a call site, per tree-sitter grammar id, with the
 *  field holding the callee expression. Verified live against the actual
 *  grammar (see graph.test.ts) for typescript/tsx/javascript/python. */
const CALL_NODE: Record<string, { type: string; functionField: string }> = {
  typescript: { type: "call_expression", functionField: "function" },
  tsx: { type: "call_expression", functionField: "function" },
  javascript: { type: "call_expression", functionField: "function" },
  python: { type: "call", functionField: "function" },
};

/** Member/attribute-access node types, per grammar id, used to resolve a
 *  callee like `obj.method()` down to `method` (the property/attribute
 *  name), and the field that holds that name. */
const MEMBER_NODE: Record<string, { type: string; propertyField: string }> = {
  typescript: { type: "member_expression", propertyField: "property" },
  tsx: { type: "member_expression", propertyField: "property" },
  javascript: { type: "member_expression", propertyField: "property" },
  python: { type: "attribute", propertyField: "attribute" },
};

/** Import-ish node types, per grammar id. Handled individually below since
 *  the shape (single source string vs. dotted-name list) differs. */
type ImportKind = "js-source" | "py-import" | "py-import-from";
const IMPORT_NODE: Record<string, ImportKind> = {
  typescript: "js-source",
  tsx: "js-source",
  javascript: "js-source",
  python: "py-import",
};

function calleeName(fnNode: Node, langId: string): string | undefined {
  if (fnNode.type === "identifier") return fnNode.text;
  const member = MEMBER_NODE[langId];
  if (member && fnNode.type === member.type) {
    return fnNode.childForFieldName(member.propertyField)?.text;
  }
  return undefined;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, "");
}

function extractImports(
  node: Node,
  langId: string,
  filePath: string,
  imports: ImportRow[],
): void {
  const kind = IMPORT_NODE[langId];
  if (!kind) return;

  if (kind === "js-source" && node.type === "import_statement") {
    const source = node.childForFieldName("source");
    if (source) {
      imports.push({
        fromPath: filePath,
        toPathOrModule: stripQuotes(source.text),
        line: node.startPosition.row + 1,
      });
    }
    return;
  }

  if (kind === "py-import" && node.type === "import_statement") {
    for (const child of namedChildrenOf(node)) {
      if (child.type === "dotted_name" || child.type === "aliased_import") {
        imports.push({
          fromPath: filePath,
          toPathOrModule: child.text,
          line: node.startPosition.row + 1,
        });
      }
    }
    return;
  }

  if (kind === "py-import" && node.type === "import_from_statement") {
    const moduleName = node.childForFieldName("module_name");
    const line = node.startPosition.row + 1;
    if (moduleName) {
      imports.push({
        fromPath: filePath,
        toPathOrModule: moduleName.text,
        line,
      });
    } else {
      // Relative import ("from . import x" / "from .. import y") — no
      // module_name field, the dots live on a relative_import child.
      const rel = namedChildrenOf(node).find(
        (c) => c.type === "relative_import",
      );
      if (rel)
        imports.push({ fromPath: filePath, toPathOrModule: rel.text, line });
    }
  }
}

/**
 * Walk the tree once, tracking the enclosing def (for calls' `caller`) and
 * emitting a ref for every identifier/type/property leaf, excluding a def's
 * own name node.
 *
 * Deliberately NOT gated to "only names this file also defines" — Lodestone
 * does no cross-file type/import resolution (see LODESTONE_DESIGN.md §4
 * item 4: name-based defs/refs/calls, not an LSP-grade binder), so refs is
 * a global name-based xref: the only way `queryRefs("exportedFn")` can see
 * a call site in a *different* file is if that file's own walk recorded the
 * occurrence too, regardless of whether `exportedFn` is one of that file's
 * own defs. Gating on same-file defSymbols would make every cross-file
 * export look permanently unused — the exact case bullet (b) tests for.
 */
function extractRefsCallsImports(
  tree: Tree,
  filePath: string,
  langId: string,
  adapter: LangAdapter,
): { refs: RefRow[]; calls: CallRow[]; imports: ImportRow[] } {
  const refs: RefRow[] = [];
  const calls: CallRow[] = [];
  const imports: ImportRow[] = [];

  const callNode = CALL_NODE[langId];

  // Best-effort exclusion set: the exact source range of each def's own
  // "name" node, so its declaration site isn't double-counted as a ref to
  // itself. Uses the same default "name" field the underlying grammars use
  // for function/class/method declarations (verified for ts/tsx/js/py;
  // best-effort elsewhere — see module doc).
  const defNameRanges = new Set<string>();
  function markDefName(node: Node): void {
    const nameNode = adapter.unwrap(node).childForFieldName("name");
    if (nameNode)
      defNameRanges.add(`${nameNode.startIndex}:${nameNode.endIndex}`);
  }

  function walk(node: Node, callerStack: string[]): void {
    const cls = adapter.classify(node);
    let nextStack = callerStack;
    // See extractDefs() above: walk from the unwrapped node's children so a
    // wrapper (e.g. TS/JS `export_statement`) doesn't re-classify its own
    // unwrapped child as a second, nested def of itself.
    let childRoot = node;
    if (cls) {
      markDefName(node);
      const symbol =
        cls.kind === "container"
          ? cls.label.slice(cls.label.indexOf(" ") + 1)
          : cls.label;
      nextStack = [...callerStack, symbol];
      childRoot = adapter.unwrap(node);
    }

    extractImports(node, langId, filePath, imports);

    if (callNode && node.type === callNode.type) {
      const fnNode = node.childForFieldName(callNode.functionField);
      const callee = fnNode ? calleeName(fnNode, langId) : undefined;
      if (callee) {
        calls.push({
          caller:
            nextStack.length > 0 ? nextStack[nextStack.length - 1] : "<module>",
          callee,
          path: filePath,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Refs: every identifier-ish leaf, excluding the def's own
    // declaration-name node — see the global-xref rationale above.
    if (
      (node.type === "identifier" ||
        node.type === "type_identifier" ||
        node.type === "property_identifier") &&
      !defNameRanges.has(`${node.startIndex}:${node.endIndex}`)
    ) {
      refs.push({
        symbol: node.text,
        path: filePath,
        line: node.startPosition.row + 1,
      });
    }

    for (const child of namedChildrenOf(childRoot)) walk(child, nextStack);
  }

  walk(tree.rootNode, []);
  return { refs, calls, imports };
}

function extractFromTree(
  tree: Tree,
  filePath: string,
  langId: string,
  adapter: LangAdapter,
): GraphExtraction {
  const defs = extractDefs(tree, filePath, adapter);

  if (!CALL_NODE[langId]) {
    // Grammar verified for defs only (see module doc) — refs/calls/imports
    // for these languages come from the regex tier instead, layered onto
    // the tree-sitter-accurate defs.
    const fallback = extractFromRegex(tree.rootNode.text, filePath, defs);
    return { ...fallback, defs, method: "tree-sitter" };
  }

  const { refs, calls, imports } = extractRefsCallsImports(
    tree,
    filePath,
    langId,
    adapter,
  );
  return { defs, refs, calls, imports, method: "tree-sitter" };
}

// --- Regex tier --------------------------------------------------------

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "def",
  "class",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const IMPORT_LINE_RE = /^\s*(?:import|from|use|require|include|#include)\b/;
const IMPORT_TARGET_RE = /(?:"([^"]+)"|'([^']+)'|<([^>]+)>)/;

/**
 * Regex fallback tier. `knownDefs`, when passed (from the hybrid
 * tree-sitter-defs-only path above), is used instead of re-deriving defs
 * via extractSymbols so def kind/range stay tree-sitter-accurate.
 */
function extractFromRegex(
  content: string,
  filePath: string,
  knownDefs?: DefRow[],
): GraphExtraction {
  const defs =
    knownDefs ??
    extractSymbols(content, filePath).map((s) => ({
      symbol: s.name,
      path: filePath,
      startLine: s.line,
      endLine: s.line,
      kind: s.kind as string,
    }));

  const lines = content.split("\n");
  const refs: RefRow[] = [];
  const calls: CallRow[] = [];
  const imports: ImportRow[] = [];

  const defByName = new Map<string, DefRow>();
  for (const d of defs)
    if (!defByName.has(d.symbol)) defByName.set(d.symbol, d);

  // refs: whole-word occurrences of a def's name on any line outside its
  // own declared range.
  for (const name of defByName.keys()) {
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g");
    const def = defByName.get(name)!;
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      if (lineNo >= def.startLine && lineNo <= def.endLine) continue;
      if (re.test(lines[i])) {
        refs.push({ symbol: name, path: filePath, line: lineNo });
      }
      re.lastIndex = 0;
    }
  }

  // calls: naive `identifier(` scan, caller = nearest enclosing
  // function/method (falls back to "<module>"). Lower fidelity than the
  // tree-sitter tier — no true scope resolution. Regex defs are line-only
  // (startLine === endLine, extractSymbols() never computes a body range),
  // so a def's "range" here is synthesized as [startLine, next def's
  // startLine - 1] unless the def already carries a real tree-sitter range
  // (the hybrid defs-only-via-tree-sitter path, e.g. Go/Rust/Java) — in
  // that case its own endLine is trusted instead.
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  const funcDefs = [...defs]
    .filter((d) => d.kind === "function" || d.kind === "method")
    .sort((a, b) => a.startLine - b.startLine);

  function callerFor(lineNo: number): string {
    let caller = "<module>";
    for (let idx = 0; idx < funcDefs.length; idx++) {
      const d = funcDefs[idx];
      if (d.startLine > lineNo) break;
      const hasRealRange = d.endLine > d.startLine;
      const upper = hasRealRange
        ? d.endLine
        : (funcDefs[idx + 1]?.startLine ?? Infinity) - 1;
      if (lineNo <= upper) caller = d.symbol;
    }
    return caller;
  }

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    let m: RegExpExecArray | null;
    callRe.lastIndex = 0;
    while ((m = callRe.exec(lines[i]))) {
      const callee = m[1];
      if (CONTROL_KEYWORDS.has(callee)) continue;
      // Skip a def's own declaration line calling itself.
      const isOwnDecl = defs.some(
        (d) => d.symbol === callee && lineNo === d.startLine,
      );
      if (isOwnDecl) continue;
      calls.push({
        caller: callerFor(lineNo),
        callee,
        path: filePath,
        line: lineNo,
      });
    }
  }

  // imports: generic "import/from/use/require/include" line scan, pull the
  // first quoted/angle-bracket target.
  for (let i = 0; i < lines.length; i++) {
    if (!IMPORT_LINE_RE.test(lines[i])) continue;
    const target = lines[i].match(IMPORT_TARGET_RE);
    const mod = target ? (target[1] ?? target[2] ?? target[3]) : undefined;
    if (mod)
      imports.push({ fromPath: filePath, toPathOrModule: mod, line: i + 1 });
  }

  return { defs, refs, calls, imports, method: "regex" };
}
