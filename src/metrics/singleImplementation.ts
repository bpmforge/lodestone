import { extractGraph } from "../symbols/graph.js";
import { languageForPath } from "../chunker/languages.js";

/**
 * Lodestone-native ANTI_SLOP R-05 detector — "single-implementation
 * interfaces/factories" (see ~/Code/bpm-opencode-experts/agents/shared/
 * ANTI_SLOP_RULES.md, Category 2 "Abstraction Slop"). Exact rule text:
 *
 *   Pattern: `interface PaymentProcessor { charge(): ... }` with exactly
 *   one implementation (`StripeProcessor`) and no second implementation in
 *   the codebase or the backlog.
 *   Rule: Abstract only when there are ≥2 concrete implementations. One =
 *   concrete class directly.
 *
 * This is a symbol-graph detector, not a rulepack rule: catching it needs
 * project-wide knowledge of *how many* classes implement/extend a given
 * interface or abstract class, which a single-file grep/AST rule cannot
 * see (see bpm-rulepacks W1-06 close note: "revisit once the symbol graph
 * lands"). It queries `extractGraph()` (symbols/graph.ts, read-only reuse —
 * no new parser) for interface/abstract-class defs, plus one small
 * language-agnostic heritage-clause scan of the raw source (the graph has
 * no `extends`/`implements` edge type — same "fill the gap, don't touch
 * the grammar" approach duplication.ts takes for clone detection).
 *
 * Scope: brace-and-keyword OOP languages only — typescript, tsx,
 * javascript, java, c_sharp, php (the languages whose adapters emit a
 * `kind: "interface"` def, see chunker/adapters.ts's ADAPTERS map).
 * Languages with a different inheritance syntax (Python's
 * `class Foo(Base):`, Go's structural interfaces, Rust's `impl Trait for`)
 * are not scanned by the heritage regex — a file in one of those languages
 * simply contributes zero implementor matches, so it undercounts (misses a
 * real single-impl case) rather than inventing a false implementor there.
 * Within the scoped languages, `stripLeadingTypeParams()` removes a
 * class's own `<T extends Bar>` type-parameter list before heritage
 * matching, so a generic bound does not get misread as the class's own
 * `extends` clause (the one false-positive shape this module actively
 * guards against — see singleImplementation.test.ts's generic-constraint
 * case; `CLASS_HEADER_RE`'s `[^{;]*` matches newlines, so a multi-line
 * `extends`/`implements` clause is still captured).
 *
 * Stable JSON shape (the contract Tier-0 consumers — CodeReckon, RepoPulse
 * — code against): `computeSingleImplementation()` resolves to an array of
 * `SingleImplementationFinding` records:
 *
 * ```json
 * [{ "rule": "R-05", "symbol": "PaymentProcessor", "path": "src/x.ts",
 *    "line": 3, "kind": "interface", "implementor": "StripeProcessor",
 *    "reason": "..." }]
 * ```
 */

export interface SingleImplementationFinding {
  rule: "R-05";
  /** Interface or abstract-class name. */
  symbol: string;
  path: string;
  /** 1-based line the def starts on. */
  line: number;
  kind: "interface" | "abstract class";
  /** The one class found implementing/extending this abstraction. */
  implementor: string;
  reason: string;
}

/** Languages whose adapters emit `kind: "interface"` container defs and
 *  use `extends`/`implements` heritage keywords (chunker/adapters.ts). */
const HERITAGE_KEYWORD_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "tsx",
  "javascript",
  "java",
  "c_sharp",
  "php",
]);

// Matches a class header up through its opening brace, e.g.
// "class StripeProcessor implements PaymentProcessor {". Deliberately does
// not try to parse generics/multi-line headers exactly — a rare miss here
// only undercounts implementors (safe direction, see module doc).
const CLASS_HEADER_RE = /\bclass\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
const EXTENDS_RE = /\bextends\s+([A-Za-z_$][\w$.]*)/;
const IMPLEMENTS_RE = /\bimplements\s+([^{]+)/;
const ABSTRACT_CLASS_RE = /\babstract\s+class\b/;

function stripGenerics(name: string): string {
  return name.replace(/<.*$/, "").trim();
}

/** Strip a class's own `<T extends Bar>` type-parameter list (if present
 *  immediately after the class name) before heritage matching — otherwise
 *  a generic bound's `extends` reads as the class's own `extends` clause
 *  and misattributes the constraint type as a base class. Balanced-bracket
 *  aware (handles one level of nesting, e.g. `<T extends Bar<X>>`); an
 *  unbalanced/unclosed list (should not occur in valid source) is left
 *  as-is rather than guessed at. */
function stripLeadingTypeParams(afterClassName: string): string {
  const trimmed = afterClassName.replace(/^\s+/, "");
  if (!trimmed.startsWith("<")) return afterClassName;

  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "<") depth++;
    else if (trimmed[i] === ">") {
      depth--;
      if (depth === 0) return trimmed.slice(i + 1);
    }
  }
  return afterClassName; // unbalanced — don't guess, leave untouched
}

/** Every base/interface name a `class X extends Y implements A, B` header
 *  references, plus the implementor's own name. */
function parseHeritage(
  header: string,
): { implementor: string; bases: string[] } | undefined {
  const classMatch = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(header);
  if (!classMatch) return undefined;
  const implementor = classMatch[1];

  const afterName = header.slice(classMatch.index + classMatch[0].length);
  const heritage = stripLeadingTypeParams(afterName);

  const bases: string[] = [];
  const extendsMatch = EXTENDS_RE.exec(heritage);
  if (extendsMatch) bases.push(stripGenerics(extendsMatch[1]));

  const implementsMatch = IMPLEMENTS_RE.exec(heritage);
  if (implementsMatch) {
    for (const raw of implementsMatch[1].split(",")) {
      const name = stripGenerics(raw);
      if (name) bases.push(name);
    }
  }

  return { implementor, bases };
}

/** Scan raw source for `class X extends/implements Y` headers, returning a
 *  global map of base-name -> set of implementor class names. Global (not
 *  per-file) by design, matching deadCode.ts's usedNames convention: an
 *  implementor in any file counts toward clearing an abstraction defined
 *  in any other file. */
function collectImplementors(
  files: Array<{ path: string; content: string }>,
): Map<string, Set<string>> {
  const implementors = new Map<string, Set<string>>();

  for (const f of files) {
    const langId = languageForPath(f.path);
    if (!langId || !HERITAGE_KEYWORD_LANGUAGES.has(langId)) continue;

    CLASS_HEADER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLASS_HEADER_RE.exec(f.content))) {
      const parsed = parseHeritage(m[0]);
      if (!parsed) continue;
      for (const base of parsed.bases) {
        let set = implementors.get(base);
        if (!set) {
          set = new Set();
          implementors.set(base, set);
        }
        set.add(parsed.implementor);
      }
    }
  }

  return implementors;
}

function reasonFor(kind: "interface" | "abstract class"): string {
  return (
    `R-05 single-implementation abstraction: this ${kind} has exactly one ` +
    `implementation in the indexed file set and no second implementation ` +
    `or backlog entry — abstract only when there are >= 2 concrete ` +
    `implementations (ANTI_SLOP_RULES.md R-05); one implementation should ` +
    `be a concrete class directly.`
  );
}

/**
 * Find interfaces and abstract classes with exactly one implementor across
 * `files`. Never throws — a file extractGraph() can't parse simply
 * contributes no defs (see extractGraph's own fallback contract).
 */
export async function computeSingleImplementation(
  files: Array<{ path: string; content: string }>,
): Promise<SingleImplementationFinding[]> {
  const implementors = collectImplementors(files);

  const findings: SingleImplementationFinding[] = [];

  for (const f of files) {
    const langId = languageForPath(f.path);
    if (!langId || !HERITAGE_KEYWORD_LANGUAGES.has(langId)) continue;

    const graph = await extractGraph(f.content, f.path);
    const lines = f.content.split("\n");

    for (const d of graph.defs) {
      if (d.kind !== "interface" && d.kind !== "class") continue;

      const isAbstract =
        d.kind === "class" &&
        ABSTRACT_CLASS_RE.test(lines[d.startLine - 1] ?? "");
      if (d.kind === "class" && !isAbstract) continue; // concrete class, not an abstraction

      const kind: "interface" | "abstract class" = isAbstract
        ? "abstract class"
        : "interface";

      const impls = implementors.get(d.symbol);
      if (!impls || impls.size !== 1) continue;

      findings.push({
        rule: "R-05",
        symbol: d.symbol,
        path: f.path,
        line: d.startLine,
        kind,
        implementor: [...impls][0],
        reason: reasonFor(kind),
      });
    }
  }

  return findings;
}
