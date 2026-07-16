/**
 * Identifier subtoken splitter — the cheapest semantic trick in Lodestone's
 * BM25F layer (see docs/LODESTONE_DESIGN.md §4.2). Splits a raw identifier
 * into its constituent words so a natural-language query like "password
 * validation" can match a symbol named `validateUserPassword` via plain
 * FTS5, with zero embedding model involved.
 *
 * Handles camelCase, PascalCase, snake_case, SCREAMING_SNAKE_CASE, and
 * kebab-case, plus embedded acronym runs (`HTTPServer` -> `http`, `server`)
 * and digit boundaries (`parseV2Config` -> `parse`, `v`, `2`, `config`).
 */

// Boundaries to split on, evaluated left-to-right over the identifier:
//   lower/digit -> upper   ("validateUser" -> "validate|User")
//   upper -> upper+lower   ("HTTPServer"   -> "HTTP|Server")
//   letter -> digit        ("v2"           -> "v|2")
//   digit -> letter        ("2Config"      -> "2|Config")
const CAMEL_BOUNDARY =
  /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/g;

/**
 * Split a raw identifier into lowercase subtokens. Returns `[]` for empty
 * or non-identifier input rather than throwing.
 */
export function splitIdentifier(identifier: string): string[] {
  if (!identifier) return [];
  return identifier
    .split(/[^A-Za-z0-9]+/) // snake_case, kebab-case, whitespace
    .flatMap((part) => part.split(CAMEL_BOUNDARY))
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Split a batch of raw identifiers into a de-duplicated, space-joined
 * subtoken string ready for the FTS5 `subtokens` column.
 */
export function subtokenText(identifiers: string[]): string {
  const seen = new Set<string>();
  for (const id of identifiers) {
    for (const tok of splitIdentifier(id)) seen.add(tok);
  }
  return [...seen].join(" ");
}
