import path from "path";

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "method"
  | "struct"
  | "trait"
  | "impl"
  | "section";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  line: number; // 1-based
  signature: string; // trimmed line, max 120 chars
}

type LangPattern = { re: RegExp; kind: SymbolKind; nameGroup: number };

const TS_JS: LangPattern[] = [
  {
    re: /^(?:export\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,
    kind: "class",
    nameGroup: 1,
  },
  { re: /^(?:export\s+)?interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
  {
    re: /^(?:export\s+)?type\s+(\w+)\s*(?:<[^>]*)?\s*=/,
    kind: "type",
    nameGroup: 1,
  },
  {
    re: /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    re: /^export\s+const\s+(\w+)\s*(?::[^=]+)?=(?!\s*(?:async\s+)?\()/,
    kind: "const",
    nameGroup: 1,
  },
  // class methods — must start with 2+ spaces/tab
  {
    re: /^[ \t]{2,}(?:(?:public|private|protected|static|async|override|abstract|readonly)\s+)*(\w+)\s*(?:<[^>]*)?\s*\(/,
    kind: "method",
    nameGroup: 1,
  },
];

const PYTHON: LangPattern[] = [
  { re: /^(?:async\s+)?def\s+(\w+)\s*\(/, kind: "function", nameGroup: 1 },
  { re: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
  // indented methods
  { re: /^[ \t]+(?:async\s+)?def\s+(\w+)\s*\(/, kind: "method", nameGroup: 1 },
];

const GO: LangPattern[] = [
  // func (recv Type) Name( or func Name(
  {
    re: /^func\s+(?:\(\s*\w*\s+\*?\w+\s*\)\s+)?(\w+)\s*[\[(]/,
    kind: "function",
    nameGroup: 1,
  },
  { re: /^type\s+(\w+)\s+struct/, kind: "struct", nameGroup: 1 },
  { re: /^type\s+(\w+)\s+interface/, kind: "interface", nameGroup: 1 },
  { re: /^type\s+(\w+)\s+/, kind: "type", nameGroup: 1 },
  { re: /^const\s+(\w+)\s*(?:=|[A-Z])/, kind: "const", nameGroup: 1 },
];

const RUST: LangPattern[] = [
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)/,
    kind: "struct",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?trait\s+(\w+)/,
    kind: "trait",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*impl(?:<[^>]+>)?\s+(?:\w+\s+for\s+)?(\w+)/,
    kind: "impl",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)/,
    kind: "type",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)/,
    kind: "const",
    nameGroup: 1,
  },
];

const JAVA_CS: LangPattern[] = [
  {
    re: /^[ \t]*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|final|record)\s+)*(?:class|record)\s+(\w+)/,
    kind: "class",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|protected|internal|static|sealed|partial)\s+)*interface\s+(\w+)/,
    kind: "interface",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|protected|internal|static)\s+)*enum\s+(\w+)/,
    kind: "enum",
    nameGroup: 1,
  },
  {
    re: /^[ \t]{2,}(?:(?:public|private|protected|internal|static|async|virtual|override|abstract|new)\s+)+\w[\w<>[\],\s]*\s+(\w+)\s*\(/,
    kind: "method",
    nameGroup: 1,
  },
];

const RUBY: LangPattern[] = [
  { re: /^def\s+(\w+)/, kind: "function", nameGroup: 1 },
  {
    re: /^[ \t]+(?:(?:private|protected|public)\s+)?def\s+(\w+)/,
    kind: "method",
    nameGroup: 1,
  },
  { re: /^class\s+(\w+)/, kind: "class", nameGroup: 1 },
  { re: /^module\s+(\w+)/, kind: "class", nameGroup: 1 },
];

const PHP: LangPattern[] = [
  {
    re: /^[ \t]*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+(\w+)\s*\(/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:abstract|final)\s+)?class\s+(\w+)/,
    kind: "class",
    nameGroup: 1,
  },
  { re: /^[ \t]*interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
  { re: /^[ \t]*enum\s+(\w+)/, kind: "enum", nameGroup: 1 },
];

const SWIFT: LangPattern[] = [
  {
    re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|required)\s+)*func\s+(\w+)/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open|final)\s+)*class\s+(\w+)/,
    kind: "class",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open)\s+)*struct\s+(\w+)/,
    kind: "struct",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open)\s+)*protocol\s+(\w+)/,
    kind: "interface",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:public|private|internal|fileprivate|open|indirect)\s+)*enum\s+(\w+)/,
    kind: "enum",
    nameGroup: 1,
  },
];

const KOTLIN: LangPattern[] = [
  {
    re: /^[ \t]*(?:(?:private|public|internal|protected|suspend|inline|override|operator|infix)\s+)*fun\s+(\w+)/,
    kind: "function",
    nameGroup: 1,
  },
  {
    re: /^[ \t]*(?:(?:data|sealed|abstract|open|inner)\s+)*class\s+(\w+)/,
    kind: "class",
    nameGroup: 1,
  },
  { re: /^[ \t]*interface\s+(\w+)/, kind: "interface", nameGroup: 1 },
  { re: /^[ \t]*object\s+(\w+)/, kind: "class", nameGroup: 1 },
  { re: /^[ \t]*enum\s+class\s+(\w+)/, kind: "enum", nameGroup: 1 },
];

const MD: LangPattern[] = [
  { re: /^#{1,6}\s+(.+)$/, kind: "section", nameGroup: 1 },
];

const SKIP_NAMES = new Set([
  "constructor",
  "super",
  "return",
  "if",
  "for",
  "while",
  "switch",
]);

function patterns(ext: string): LangPattern[] {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return TS_JS;
    case ".py":
      return PYTHON;
    case ".go":
      return GO;
    case ".rs":
      return RUST;
    case ".java":
      return JAVA_CS;
    case ".cs":
      return JAVA_CS;
    case ".rb":
      return RUBY;
    case ".php":
      return PHP;
    case ".swift":
      return SWIFT;
    case ".kt":
    case ".kts":
      return KOTLIN;
    case ".md":
    case ".mdx":
      return MD;
    default:
      return [];
  }
}

export function extractSymbols(
  content: string,
  filePath: string,
): CodeSymbol[] {
  const ext = path.extname(filePath).toLowerCase();
  const pats = patterns(ext);
  if (pats.length === 0) return [];

  const symbols: CodeSymbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip blank lines and single-line comments
    const trimmed = raw.trimStart();
    if (
      !trimmed ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("#!")
    )
      continue;

    for (const { re, kind, nameGroup } of pats) {
      const m = raw.match(re);
      if (!m) continue;
      const name = (m[nameGroup] ?? "").trim();
      if (name.length < 2 || SKIP_NAMES.has(name)) continue;

      symbols.push({
        name,
        kind,
        line: i + 1,
        signature: raw.trimEnd().slice(0, 120),
      });
      break; // first matching pattern wins per line
    }
  }

  return symbols;
}
