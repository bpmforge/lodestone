export interface Chunk {
  text: string;
  startLine: number; // 1-based
  endLine: number; // 1-based, inclusive

  /**
   * File path + enclosing symbol chain, e.g.
   * "src/auth.ts > class UserService > authenticate".
   * Only populated by the AST chunker; undefined for window-fallback chunks.
   * Additive field — existing consumers (indexer/db) don't read it.
   */
  header?: string;

  /**
   * The enclosing symbol chain alone (no file path), e.g.
   * ["class UserService", "authenticate"]. Additive, AST-chunker only.
   */
  symbolChain?: string[];
}
