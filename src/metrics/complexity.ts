import type { Node, Tree } from "web-tree-sitter";
import {
  languageForPath,
  loadLanguage,
  getParser,
} from "../chunker/languages.js";
import { ADAPTERS, type LangAdapter } from "../chunker/adapters.js";

/**
 * Lodestone-native complexity metric — the in-house replacement for the
 * external `lizard` tool (see docs/LODESTONE_DESIGN.md §7 "in-house
 * ladder"). Reuses the exact tree-sitter setup the cAST chunker already
 * wires up (`languageForPath` / `loadLanguage` / `getParser` from
 * chunker/languages.ts, `ADAPTERS` from chunker/adapters.ts) instead of
 * adding a second parser or shelling out to a Python tool.
 *
 * Stable JSON shape (this is the contract Tier-0 consumers — CodeReckon,
 * RepoPulse — code against): `computeComplexity()` resolves to a plain
 * array of `FunctionComplexity` records, one per function/method found in
 * the file:
 *
 * ```json
 * [{ "name": "class UserService > authenticate", "path": "src/auth.ts", "line": 12, "cyclomatic": 3, "cognitive": 4 }]
 * ```
 *
 * A file with no wired grammar (see EXT_TO_LANG in chunker/languages.ts) or
 * no complexity config for its language resolves to `[]` — never throws.
 * `lizard` (or any other external tool) becomes optional: a consumer that
 * previously shelled out to it can call this instead and get the same
 * per-function shape.
 */
export interface FunctionComplexity {
  /** Symbol chain of the function, e.g. "class UserService > authenticate". */
  name: string;
  /** File path as passed in to computeComplexity(). */
  path: string;
  /** 1-based line the function starts on. */
  line: number;
  /** McCabe cyclomatic complexity: 1 + count of decision points
   *  (if/elif/for/while/do/case/catch/except/ternary, each `&&`/`||`
   *  occurrence). A straight-line function is 1; N independent branches
   *  raise it to N+1. */
  cyclomatic: number;
  /** Nesting-weighted complexity, inspired by (not a byte-exact port of)
   *  Sonar's Cognitive Complexity: each decision structure adds
   *  1 + current-nesting-depth, so the same branch costs more the deeper
   *  it's nested; boolean-operator chains add a flat 1 each. */
  cognitive: number;
}

interface ComplexityLangConfig {
  /** Node types where the node's mere presence is one cyclomatic decision
   *  point (counted once per occurrence, regardless of nesting). */
  decisionTypes: Set<string>;
  /** Node types that both (a) add a decision point AND (b) open a new
   *  nesting level for cognitive complexity — if/for/while/do/catch/
   *  except/switch/ternary. Cognitive adds 1 + nesting for each. */
  nestingTypes: Set<string>;
  /** Node types that add a flat (no nesting weight) cognitive increment —
   *  a plain `else`/`elif` continuing an existing if-chain. Not counted
   *  for cyclomatic (the branch itself is already counted via the nested
   *  if_statement / elif_clause in decisionTypes). */
  flatCognitiveTypes: Set<string>;
  /** Node type that wraps a binary boolean operator (`&&`/`||`/`and`/`or`).
   *  Checked by scanning the node's own direct children for a token whose
   *  type is one of `logicalTokens` (tree-sitter represents operator
   *  tokens as anonymous nodes whose type is the literal, e.g. "&&"). */
  logicalNodeType: string;
  logicalTokens: Set<string>;
}

// --- TypeScript / TSX / JavaScript ---------------------------------------
// Verified against the bundled tree-sitter-{typescript,tsx,javascript}
// grammars: if_statement, for_statement, for_in_statement (covers both
// for-in and for-of), while_statement, do_statement, catch_clause,
// ternary_expression, switch_case/switch_default, binary_expression with
// an anonymous "&&"/"||" child. "else if" is a nested if_statement inside
// else_clause, so it's already covered by if_statement — else_clause
// itself only gets the flat cognitive bump.
const JS_LIKE_CONFIG: ComplexityLangConfig = {
  decisionTypes: new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "ternary_expression",
    "switch_case",
    "switch_default",
  ]),
  nestingTypes: new Set([
    "if_statement",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "catch_clause",
    "switch_statement",
    "ternary_expression",
  ]),
  flatCognitiveTypes: new Set(["else_clause"]),
  logicalNodeType: "binary_expression",
  logicalTokens: new Set(["&&", "||"]),
};

// --- Python ----------------------------------------------------------------
// if_statement, elif_clause (a real branch — python represents "elif" as a
// sibling clause, not a nested if_statement, unlike JS), for_statement,
// while_statement, except_clause, conditional_expression (ternary),
// case_clause (match/case, if the file uses it). boolean_operator wraps
// "and"/"or" as an anonymous child.
const PYTHON_CONFIG: ComplexityLangConfig = {
  decisionTypes: new Set([
    "if_statement",
    "elif_clause",
    "for_statement",
    "while_statement",
    "except_clause",
    "conditional_expression",
    "case_clause",
  ]),
  nestingTypes: new Set([
    "if_statement",
    "for_statement",
    "while_statement",
    "except_clause",
    "conditional_expression",
    "match_statement",
  ]),
  flatCognitiveTypes: new Set(["elif_clause", "else_clause"]),
  logicalNodeType: "boolean_operator",
  logicalTokens: new Set(["and", "or"]),
};

// --- Go ----------------------------------------------------------------
// No exceptions (no catch) and no ternary. "else if" is a nested
// if_statement in the alternative field, same as JS. Switch/select arms:
// expression_case / type_case / communication_case / default_case.
const GO_CONFIG: ComplexityLangConfig = {
  decisionTypes: new Set([
    "if_statement",
    "for_statement",
    "expression_case",
    "type_case",
    "communication_case",
    "default_case",
  ]),
  nestingTypes: new Set([
    "if_statement",
    "for_statement",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
  ]),
  flatCognitiveTypes: new Set(["else_clause"]),
  logicalNodeType: "binary_expression",
  logicalTokens: new Set(["&&", "||"]),
};

/** Keyed by the same langId chunker/languages.ts resolves from EXT_TO_LANG.
 *  A langId with no entry here (rust, java, c_sharp, ruby, php, c, cpp —
 *  grammar wired for chunking, but no complexity config yet) skips
 *  gracefully rather than guessing at unverified node type names. */
const COMPLEXITY_CONFIGS: Partial<Record<string, ComplexityLangConfig>> = {
  typescript: JS_LIKE_CONFIG,
  tsx: JS_LIKE_CONFIG,
  javascript: JS_LIKE_CONFIG,
  python: PYTHON_CONFIG,
  go: GO_CONFIG,
};

/** Languages this module currently scores (see COMPLEXITY_CONFIGS). */
export const SUPPORTED_LANGUAGES: readonly string[] =
  Object.keys(COMPLEXITY_CONFIGS);

function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

function hasLogicalToken(node: Node, tokens: Set<string>): boolean {
  for (const c of node.children) {
    if (c && tokens.has(c.type)) return true;
  }
  return false;
}

/** Mirrors chunker/astChunk.ts's collectChunks() traversal: recurse into
 *  container bodies (class/interface/impl/...) to find nested units
 *  (methods), stop at unit boundaries (a unit's own body is not searched
 *  for further nested units — it's scored as one function, same
 *  granularity the chunker treats as one chunk). */
function findUnits(
  siblings: Node[],
  chain: string[],
  adapter: LangAdapter,
  out: { node: Node; chain: string[] }[],
): void {
  for (const node of siblings) {
    const cls = adapter.classify(node);
    if (!cls) continue;

    if (cls.kind === "container") {
      const newChain = [...chain, cls.label];
      const body = adapter.unwrap(node).childForFieldName("body");
      if (body) findUnits(namedChildrenOf(body), newChain, adapter, out);
    } else {
      const unitChain = [...chain, ...(cls.extraChain ?? []), cls.label];
      out.push({ node, chain: unitChain });
    }
  }
}

function scoreCyclomatic(node: Node, config: ComplexityLangConfig): number {
  let decisions = 0;
  const walk = (n: Node): void => {
    if (config.decisionTypes.has(n.type)) decisions++;
    if (
      n.type === config.logicalNodeType &&
      hasLogicalToken(n, config.logicalTokens)
    ) {
      decisions++;
    }
    for (const c of namedChildrenOf(n)) walk(c);
  };
  for (const c of namedChildrenOf(node)) walk(c);
  return 1 + decisions;
}

function scoreCognitive(node: Node, config: ComplexityLangConfig): number {
  let score = 0;
  const walk = (n: Node, nesting: number): void => {
    let nextNesting = nesting;
    if (config.nestingTypes.has(n.type)) {
      score += 1 + nesting;
      nextNesting = nesting + 1;
    } else if (config.flatCognitiveTypes.has(n.type)) {
      score += 1;
    } else if (
      n.type === config.logicalNodeType &&
      hasLogicalToken(n, config.logicalTokens)
    ) {
      score += 1;
    }
    for (const c of namedChildrenOf(n)) walk(c, nextNesting);
  };
  for (const c of namedChildrenOf(node)) walk(c, 0);
  return score;
}

function scoreTree(
  tree: Tree,
  filePath: string,
  adapter: LangAdapter,
  config: ComplexityLangConfig,
): FunctionComplexity[] {
  const units: { node: Node; chain: string[] }[] = [];
  findUnits(namedChildrenOf(tree.rootNode), [], adapter, units);

  return units.map(({ node, chain }) => ({
    name: chain.join(" > "),
    path: filePath,
    line: node.startPosition.row + 1,
    cyclomatic: scoreCyclomatic(node, config),
    cognitive: scoreCognitive(node, config),
  }));
}

/**
 * Compute cyclomatic + cognitive complexity for every function/method in a
 * file, walking the same tree-sitter AST the cAST chunker parses (see
 * chunker/index.ts's chunkFile — this mirrors its language-resolution and
 * fallback contract). Returns `[]` — never throws — for empty content, a
 * grammarless extension, an unsupported language (see
 * SUPPORTED_LANGUAGES), or any tree-sitter failure, so a caller can run
 * this over an entire repo without special-casing files it doesn't cover.
 */
export async function computeComplexity(
  content: string,
  filePath: string,
): Promise<FunctionComplexity[]> {
  if (content.trim().length === 0) return [];

  const langId = languageForPath(filePath);
  const adapter = langId ? ADAPTERS[langId] : undefined;
  const config = langId ? COMPLEXITY_CONFIGS[langId] : undefined;
  if (!langId || !adapter || !config) return [];

  try {
    const language = await loadLanguage(langId);
    if (!language) return [];

    const parser = await getParser(language);
    const tree = parser.parse(content);
    if (!tree) return [];

    return scoreTree(tree, filePath, adapter, config);
  } catch {
    return [];
  }
}
