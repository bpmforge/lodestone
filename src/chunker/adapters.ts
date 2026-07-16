import type { Node } from "web-tree-sitter";

export interface Classification {
  kind: "container" | "unit";
  /** e.g. "class UserService" (container) or "authenticate" (unit). */
  label: string;
  /**
   * Extra chain segments to splice in before `label` for a unit that isn't
   * lexically nested in AST terms but conceptually is — e.g. a Go method's
   * receiver type ("UserService") isn't a parent node of the method, it's
   * a field on it.
   */
  extraChain?: string[];
}

export interface LangAdapter {
  classify(node: Node): Classification | null;
  /** Node types considered a splittable statement block (gates the
   *  oversized-unit split in astChunk.ts — never split anything else). */
  blockTypes: Set<string>;
  /**
   * Unwrap a wrapper node (e.g. JS/TS `export_statement`) to the inner
   * declaration before looking up its "body" field. Text/line ranges for
   * the emitted chunk still come from the original (wrapped) node, so
   * "export " stays in the chunk text — only body-field lookup needs the
   * unwrapped node. Defaults to identity.
   */
  unwrap(node: Node): Node;
}

function nameOf(node: Node, field = "name"): string {
  return node.childForFieldName(field)?.text ?? "<anonymous>";
}

function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

type ContainerConfig = { label: string; nameField?: string };

/** Factory for the common shape: containers keyed by node.type -> label
 *  prefix, units keyed by node.type -> "name" field. Covers Java, C#,
 *  Ruby, PHP, Rust with per-language config. */
function makeAdapter(
  containers: Record<string, ContainerConfig>,
  unitTypes: Set<string>,
  blockTypes: Set<string>,
): LangAdapter {
  return {
    blockTypes,
    unwrap: (node) => node,
    classify(node: Node): Classification | null {
      const container = containers[node.type];
      if (container) {
        return {
          kind: "container",
          label: `${container.label} ${nameOf(node, container.nameField)}`,
        };
      }
      if (unitTypes.has(node.type)) {
        return { kind: "unit", label: nameOf(node) };
      }
      return null;
    },
  };
}

// --- TypeScript / TSX / JavaScript --------------------------------------

const JS_LIKE_FUNCTION_VALUES = new Set([
  "arrow_function",
  "function_expression",
  "function",
  "generator_function",
]);

function unwrapExport(node: Node): Node {
  if (node.type === "export_statement") {
    return node.childForFieldName("declaration") ?? node;
  }
  return node;
}

function makeJsLikeAdapter(includeInterface: boolean): LangAdapter {
  const containers: Record<string, string> = {
    class_declaration: "class",
    abstract_class_declaration: "class",
  };
  if (includeInterface) {
    containers.interface_declaration = "interface";
  }
  const unitTypes = new Set([
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
  ]);

  return {
    blockTypes: new Set(["statement_block"]),
    unwrap: unwrapExport,
    classify(node: Node): Classification | null {
      const effective = unwrapExport(node);
      const containerLabel = containers[effective.type];
      if (containerLabel) {
        return {
          kind: "container",
          label: `${containerLabel} ${nameOf(effective)}`,
        };
      }
      if (unitTypes.has(effective.type)) {
        return { kind: "unit", label: nameOf(effective) };
      }
      // const foo = () => {}  /  const foo = function () {}
      if (
        effective.type === "lexical_declaration" ||
        effective.type === "variable_declaration"
      ) {
        const declarators = namedChildrenOf(effective).filter(
          (c) => c.type === "variable_declarator",
        );
        if (declarators.length === 1) {
          const value = declarators[0].childForFieldName("value");
          if (value && JS_LIKE_FUNCTION_VALUES.has(value.type)) {
            return { kind: "unit", label: nameOf(declarators[0]) };
          }
        }
      }
      return null;
    },
  };
}

// --- Python --------------------------------------------------------------

const PYTHON_ADAPTER: LangAdapter = makeAdapter(
  { class_definition: { label: "class" } },
  new Set(["function_definition"]),
  new Set(["block"]),
);

// --- Go (no lexical class nesting — receiver is a field, not a parent) --

function extractGoReceiverType(node: Node): string | undefined {
  const receiver = node.childForFieldName("receiver");
  if (!receiver) return undefined;
  const param = namedChildrenOf(receiver).find(
    (c) => c.type === "parameter_declaration",
  );
  const typeNode = param?.childForFieldName("type");
  if (!typeNode) return undefined;
  if (typeNode.type === "pointer_type") {
    return typeNode.namedChild(0)?.text;
  }
  return typeNode.text;
}

const GO_ADAPTER: LangAdapter = {
  blockTypes: new Set(["block"]),
  unwrap: (node) => node,
  classify(node: Node): Classification | null {
    if (node.type === "function_declaration") {
      return { kind: "unit", label: nameOf(node) };
    }
    if (node.type === "method_declaration") {
      const receiver = extractGoReceiverType(node);
      return {
        kind: "unit",
        label: nameOf(node),
        extraChain: receiver ? [receiver] : undefined,
      };
    }
    return null;
  },
};

// --- C / C++ (name is nested inside a declarator chain) ------------------

function extractCFunctionName(node: Node): string {
  let cur: Node | null = node.childForFieldName("declarator");
  while (cur) {
    if (cur.type === "identifier" || cur.type === "field_identifier") {
      return cur.text;
    }
    if (cur.type === "qualified_identifier") {
      const name = cur.childForFieldName("name");
      if (name) return name.text;
    }
    const inner: Node | null = cur.childForFieldName("declarator");
    if (!inner) break;
    cur = inner;
  }
  return "<anonymous>";
}

const C_CONTAINERS: Record<string, string> = {
  class_specifier: "class",
  struct_specifier: "struct",
  namespace_definition: "namespace",
};

const C_LIKE_ADAPTER: LangAdapter = {
  blockTypes: new Set(["compound_statement"]),
  unwrap: (node) => node,
  classify(node: Node): Classification | null {
    const containerLabel = C_CONTAINERS[node.type];
    if (containerLabel) {
      return { kind: "container", label: `${containerLabel} ${nameOf(node)}` };
    }
    if (node.type === "function_definition") {
      return { kind: "unit", label: extractCFunctionName(node) };
    }
    return null;
  },
};

// --- Registry --------------------------------------------------------------

export const ADAPTERS: Record<string, LangAdapter> = {
  typescript: makeJsLikeAdapter(true),
  tsx: makeJsLikeAdapter(true),
  javascript: makeJsLikeAdapter(false),
  python: PYTHON_ADAPTER,
  go: GO_ADAPTER,
  rust: makeAdapter(
    {
      impl_item: { label: "impl", nameField: "type" },
      trait_item: { label: "trait" },
      mod_item: { label: "mod" },
    },
    new Set(["function_item"]),
    new Set(["block"]),
  ),
  java: makeAdapter(
    {
      class_declaration: { label: "class" },
      interface_declaration: { label: "interface" },
      enum_declaration: { label: "enum" },
    },
    new Set(["method_declaration", "constructor_declaration"]),
    new Set(["block"]),
  ),
  c_sharp: makeAdapter(
    {
      class_declaration: { label: "class" },
      interface_declaration: { label: "interface" },
      struct_declaration: { label: "struct" },
    },
    new Set(["method_declaration", "constructor_declaration"]),
    new Set(["block"]),
  ),
  ruby: makeAdapter(
    {
      class: { label: "class" },
      module: { label: "module" },
    },
    new Set(["method", "singleton_method"]),
    new Set(["body_statement"]),
  ),
  php: makeAdapter(
    {
      class_declaration: { label: "class" },
      interface_declaration: { label: "interface" },
      trait_declaration: { label: "trait" },
    },
    new Set(["method_declaration", "function_definition"]),
    new Set(["compound_statement"]),
  ),
  c: C_LIKE_ADAPTER,
  cpp: C_LIKE_ADAPTER,
};
