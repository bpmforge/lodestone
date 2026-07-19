import { languageForPath } from "../chunker/languages.js";

/**
 * Lodestone-native ANTI_SLOP R-25 detector — "Phantom Imports" (see
 * ~/Code/bpm-opencode-experts/agents/shared/ANTI_SLOP_RULES.md, Category 7
 * "Structural Slop 2025-2026"). Exact rule text:
 *
 *   Pattern: `import { something } from 'nonexistent-package'` that passes
 *   TypeScript compilation (e.g., it's installed as a dev dep) but is
 *   never referenced. Or Python `import requests` that is used nowhere in
 *   the file.
 *   Rule: Every import must have at least one use in the file. Run
 *   `eslint --rule 'no-unused-vars'` and `pylint W0611` in CI with
 *   `--max-warnings 0`.
 *
 * This ticket's bpm-rulepacks sibling (W1-08 close note) deferred R-25 to
 * "tool/LLM tier" because a single-file grep/AST rule can flag an unused
 * *identifier* but can't reliably parse *which names an import statement
 * bound* without a real import-clause parser. This module is that parser
 * — self-contained regex extraction of bound names per import statement
 * (TS/TSX/JS destructuring/default/namespace forms, Python
 * import/from-import forms), the same "fill the gap, no new grammar"
 * approach duplication.ts takes for clone detection. It deliberately does
 * NOT reuse symbols/graph.ts's `ImportRow`: that type records only the
 * imported module path (see graph.ts's extractImports()), not the bound
 * local names, so it cannot answer "which name is unused" — only "which
 * module was imported."
 *
 * Unlike computeDeadCode()'s confidence tiering (which exists because refs
 * for 8/12 languages are cross-file-*unreliable*), R-25 is inherently a
 * same-file check ("at least one use IN THE FILE") — no cross-file
 * ambiguity to tier by, so every finding here is reported at uniform
 * confidence.
 *
 * Scope: typescript, tsx, javascript, python — the same four languages
 * symbols/graph.ts's own IMPORT_NODE map recognizes import syntax for.
 * Side-effect-only imports (`import "./polyfill"`, Python's
 * `from x import *`) bind no name and are never flagged — there is
 * nothing to check unused-ness of.
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computePhantomImports()` resolves to an array of
 * `PhantomImportFinding` records:
 *
 * ```json
 * [{ "rule": "R-25", "symbol": "something", "path": "src/x.ts", "line": 3,
 *    "module": "nonexistent-package", "reason": "..." }]
 * ```
 */

export interface PhantomImportFinding {
  rule: "R-25";
  /** The bound local name (post-`as`-alias for renamed imports). */
  symbol: string;
  path: string;
  /** 1-based line the import statement starts on. */
  line: number;
  /** The module/package path the phantom name was imported from. */
  module: string;
  reason: string;
}

interface Binding {
  name: string;
  module: string;
  /** 1-based inclusive line range of the import statement itself, so a
   *  usage scan can exclude the declaration site. */
  startLine: number;
  endLine: number;
}

const SCOPED_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
  "python",
]);

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

// --- TS/TSX/JS import-clause parsing ----------------------------------

const JS_IMPORT_RE = /import\s+(type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;

function parseJsClause(clause: string): string[] {
  const names: string[] = [];
  let rest = clause;

  const namedMatch = /\{([^}]*)\}/.exec(rest);
  if (namedMatch) {
    for (const raw of namedMatch[1].split(",")) {
      // Strip a per-specifier inline `type` qualifier (`import { type Foo }`)
      // — without this, "type Foo" (with no " as ") is read as one bound
      // name literally called "type Foo", which can never match a real
      // `Foo` usage and produces a false phantom-import finding.
      const item = raw.trim().replace(/^type\s+/, "");
      if (!item) continue;
      const asIdx = item.indexOf(" as ");
      names.push(asIdx === -1 ? item : item.slice(asIdx + 4).trim());
    }
    rest =
      rest.slice(0, namedMatch.index) +
      rest.slice(namedMatch.index + namedMatch[0].length);
  }

  rest = rest.replace(/,/g, " ").trim();
  if (rest.length === 0) return names;

  const nsMatch = /^\*\s+as\s+(\w+)$/.exec(rest);
  if (nsMatch) {
    names.push(nsMatch[1]);
    return names;
  }

  const defaultMatch = /^(\w+)$/.exec(rest);
  if (defaultMatch) names.push(defaultMatch[1]);

  return names;
}

function extractJsBindings(content: string): Binding[] {
  const bindings: Binding[] = [];
  JS_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JS_IMPORT_RE.exec(content))) {
    const [full, , clause, module] = m;
    const startLine = lineAt(content, m.index);
    const endLine = lineAt(content, m.index + full.length);
    for (const name of parseJsClause(clause)) {
      bindings.push({ name, module, startLine, endLine });
    }
  }
  return bindings;
}

// --- Python import parsing ----------------------------------------------

const PY_IMPORT_RE = /^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?[ \t]*$/gm;
const PY_FROM_IMPORT_RE =
  /^[ \t]*from\s+([\w.]+)\s+import\s+(\*|\([\s\S]*?\)|[^\n]+)$/gm;

function extractPyBindings(content: string): Binding[] {
  const bindings: Binding[] = [];

  PY_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PY_IMPORT_RE.exec(content))) {
    const [, dotted, alias] = m;
    const name = alias ?? dotted.split(".")[0];
    const line = lineAt(content, m.index);
    bindings.push({ name, module: dotted, startLine: line, endLine: line });
  }

  PY_FROM_IMPORT_RE.lastIndex = 0;
  while ((m = PY_FROM_IMPORT_RE.exec(content))) {
    const [full, module, rawList] = m;
    if (rawList.trim() === "*") continue; // star import — nothing specific to check
    const startLine = lineAt(content, m.index);
    const endLine = lineAt(content, m.index + full.length);
    const list = rawList.replace(/^\(|\)$/g, "");
    for (const raw of list.split(",")) {
      const item = raw.trim();
      if (!item) continue;
      const asIdx = item.indexOf(" as ");
      const name = asIdx === -1 ? item : item.slice(asIdx + 4).trim();
      bindings.push({ name, module, startLine, endLine });
    }
  }

  return bindings;
}

function reasonFor(name: string, module: string): string {
  return (
    `R-25 phantom import: "${name}" is imported from "${module}" but has ` +
    `no reference anywhere else in the file (ANTI_SLOP_RULES.md R-25: ` +
    `every import must have at least one use in the file).`
  );
}

/**
 * Find imported bindings with zero references elsewhere in their own file.
 * Never throws — a file with no matching import syntax simply contributes
 * no bindings.
 */
export function computePhantomImports(
  files: Array<{ path: string; content: string }>,
): PhantomImportFinding[] {
  const findings: PhantomImportFinding[] = [];

  for (const f of files) {
    const langId = languageForPath(f.path);
    if (!langId || !SCOPED_LANGUAGES.has(langId)) continue;

    const bindings =
      langId === "python"
        ? extractPyBindings(f.content)
        : extractJsBindings(f.content);
    if (bindings.length === 0) continue;

    const lines = f.content.split("\n");

    for (const b of bindings) {
      const re = new RegExp(`\\b${b.name}\\b`, "g");
      let used = false;
      for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        if (lineNo >= b.startLine && lineNo <= b.endLine) continue;
        if (re.test(lines[i])) {
          used = true;
          break;
        }
        re.lastIndex = 0;
      }
      if (!used) {
        findings.push({
          rule: "R-25",
          symbol: b.name,
          path: f.path,
          line: b.startLine,
          module: b.module,
          reason: reasonFor(b.name, b.module),
        });
      }
    }
  }

  return findings;
}
