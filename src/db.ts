import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";
import fs from "fs";
import type { ProviderMeta } from "./embeddings/index.js";
import type { CodeSymbol, SymbolKind } from "./symbols/extractor.js";
import type { DefRow, RefRow, CallRow, ImportRow } from "./symbols/graph.js";
import { subtokenText } from "./search/subtokens.js";

export interface Chunk {
  id: number;
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  fileMtime: number;
  embeddingProvider: string;
}

export interface SearchResult extends Chunk {
  score: number;
}

export interface SymbolRow {
  filePath: string;
  name: string;
  kind: SymbolKind;
  line: number;
  signature: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path         TEXT    NOT NULL,
  chunk_text        TEXT    NOT NULL,
  symbols_text      TEXT    NOT NULL DEFAULT '',
  subtokens_text    TEXT    NOT NULL DEFAULT '',
  start_line        INTEGER NOT NULL,
  end_line          INTEGER NOT NULL,
  file_mtime        INTEGER NOT NULL,
  embedding_provider TEXT   NOT NULL,
  embedding         BLOB    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
CREATE INDEX IF NOT EXISTS idx_chunks_mtime ON chunks(file_path, file_mtime);

-- BM25F-style weighted columns: symbols (raw identifiers, high weight),
-- subtokens (camelCase/snake_case split, mid weight), body (chunk text,
-- low weight). porter+unicode61 stems query terms so "validation" matches
-- an indexed "validate" subtoken without any embedding model. See
-- docs/LODESTONE_DESIGN.md §4.2 and CodeSearchDb.searchFts/searchFtsForName
-- for the per-column bm25() weights applied at query time.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  symbols,
  subtokens,
  body,
  content=chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, symbols, subtokens, body)
  VALUES (new.id, new.symbols_text, new.subtokens_text, new.chunk_text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, symbols, subtokens, body)
  VALUES ('delete', old.id, old.symbols_text, old.subtokens_text, old.chunk_text);
END;

CREATE TABLE IF NOT EXISTS symbols (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path  TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  line       INTEGER NOT NULL,
  signature  TEXT    NOT NULL,
  file_mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);

-- Symbol graph tables (see docs/LODESTONE_DESIGN.md §4 item 4 and
-- src/symbols/graph.ts). Additive to the existing "symbols" table above
-- (which stays as-is for outline/rename-style name lookups); these back
-- "who calls X" / "is export Y unused" / import-map queries. Tier-1
-- retrieval (W3-06) is the consumer — nothing in this repo queries them yet.
CREATE TABLE IF NOT EXISTS defs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  file_mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_defs_symbol ON defs(symbol COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_defs_file ON defs(file_path);

CREATE TABLE IF NOT EXISTS refs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol     TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  line       INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_refs_symbol ON refs(symbol COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_refs_file ON refs(file_path);

CREATE TABLE IF NOT EXISTS calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  caller     TEXT    NOT NULL,
  callee     TEXT    NOT NULL,
  file_path  TEXT    NOT NULL,
  line       INTEGER NOT NULL,
  file_mtime INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file_path);

CREATE TABLE IF NOT EXISTS imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_path         TEXT    NOT NULL,
  to_path_or_module TEXT    NOT NULL,
  line              INTEGER NOT NULL,
  file_mtime        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imports_from ON imports(from_path);
CREATE INDEX IF NOT EXISTS idx_imports_to ON imports(to_path_or_module);
`;

// bm25() column weights, in chunks_fts column order [symbols, subtokens, body].
// Higher weight = a hit in that column pulls the fused score further negative
// (FTS5 bm25 is a "lower is better" cost; results are ORDER BY score ASC and
// negated for display) so raw-identifier hits outrank subtoken hits, which
// outrank plain body-text hits, for the same query term.
const BM25_SYMBOLS_WEIGHT = 10.0;
const BM25_SUBTOKENS_WEIGHT = 5.0;
const BM25_BODY_WEIGHT = 1.0;

export class CodeSearchDb {
  private db: Database.Database;
  /** True when the sqlite-vec ANN extension loaded (falls back to brute force if not). */
  private vecEnabled = false;
  /** Dimension of the current vec_chunks table, if built. */
  private vecDim: number | null = null;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    const needsFtsBackfill = this.migrateLegacyFts();
    this.db.exec(SCHEMA); // create tables first — the vec-dim read below needs `meta`
    if (needsFtsBackfill) {
      // Pre-BM25F index: chunks survive, but the old single-column FTS5
      // table was dropped above and just got recreated with the new
      // symbols/subtokens/body schema. Backfill body from existing
      // chunk_text so search keeps working immediately; symbols/subtokens
      // stay empty until each file is next re-indexed (mtime-driven).
      this.db.exec(
        `INSERT INTO chunks_fts(rowid, symbols, subtokens, body)
         SELECT id, symbols_text, subtokens_text, chunk_text FROM chunks`,
      );
    }
    // Load the sqlite-vec ANN extension. If it can't load (platform/ABI), the
    // engine still works — every vector query falls back to the brute-force
    // cosine scan. ANN is a pure speedup, never a correctness dependency.
    try {
      sqliteVec.load(this.db);
      this.vecEnabled = true;
      const row = this.db
        .prepare("SELECT value FROM meta WHERE key = 'vec_dim'")
        .get() as { value: string } | undefined;
      if (row) this.vecDim = Number(row.value);
    } catch {
      this.vecEnabled = false;
    }
  }

  get annEnabled(): boolean {
    return this.vecEnabled;
  }

  /**
   * Upgrade an on-disk index created before the BM25F schema (single-column
   * `chunks_fts(chunk_text)`, no symbols_text/subtokens_text columns). Adds
   * the new columns and drops the old FTS5 table + triggers so the SCHEMA
   * exec below recreates them with the weighted symbols/subtokens/body
   * layout. Returns true if a backfill INSERT is needed after SCHEMA runs.
   * No-op (returns false) for a fresh db or one already on the new schema.
   */
  private migrateLegacyFts(): boolean {
    const cols = this.db.prepare("PRAGMA table_info(chunks)").all() as Array<{
      name: string;
    }>;
    if (cols.length === 0) return false; // fresh db — SCHEMA creates everything
    if (cols.some((c) => c.name === "symbols_text")) return false; // already migrated

    this.db.exec(`
      ALTER TABLE chunks ADD COLUMN symbols_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE chunks ADD COLUMN subtokens_text TEXT NOT NULL DEFAULT '';
      DROP TRIGGER IF EXISTS chunks_ai;
      DROP TRIGGER IF EXISTS chunks_ad;
      DROP TABLE IF EXISTS chunks_fts;
    `);
    return true;
  }

  private vecTableExists(): boolean {
    return (
      this.vecEnabled &&
      !!this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE name = 'vec_chunks' LIMIT 1",
        )
        .get()
    );
  }

  /**
   * Ensure the vec0 ANN table exists for `dim`. Uses cosine distance so ANN
   * scores match the brute-force cosine scan. Recreates it if the dimension
   * changed (provider swap). No-op when the extension didn't load.
   */
  private ensureVecTable(dim: number): void {
    if (!this.vecEnabled) return;
    if (this.vecDim === dim && this.vecTableExists()) return;
    if (this.vecDim !== null && this.vecDim !== dim) {
      this.db.exec("DROP TABLE IF EXISTS vec_chunks");
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dim}] distance_metric=cosine)`,
    );
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('vec_dim', ?)")
      .run(String(dim));
    this.vecDim = dim;
  }

  getProviderMeta(): ProviderMeta | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get("provider") as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  setProviderMeta(meta: ProviderMeta): void {
    this.db
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("provider", JSON.stringify(meta));
  }

  getFileMtime(filePath: string): number | null {
    const row = this.db
      .prepare("SELECT file_mtime FROM chunks WHERE file_path = ? LIMIT 1")
      .get(filePath) as { file_mtime: number } | undefined;
    return row?.file_mtime ?? null;
  }

  /** Delete all chunks AND symbols for a file (plus its ANN rows). */
  deleteFile(filePath: string): void {
    if (this.vecTableExists()) {
      const ids = this.db
        .prepare("SELECT id FROM chunks WHERE file_path = ?")
        .all(filePath) as Array<{ id: number }>;
      const del = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
      for (const { id } of ids) del.run(BigInt(id));
    }
    this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM symbols WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM defs WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM refs WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM calls WHERE file_path = ?").run(filePath);
    this.db.prepare("DELETE FROM imports WHERE from_path = ?").run(filePath);
  }

  insertChunks(
    chunks: Array<{
      filePath: string;
      chunkText: string;
      startLine: number;
      endLine: number;
      fileMtime: number;
      embeddingProvider: string;
      embedding: Float32Array;
      /** Raw identifiers (symbol names) declared within this chunk's line
       * range. Populates the FTS5 `symbols` column verbatim and the
       * `subtokens` column via camelCase/snake_case splitting. Optional —
       * defaults to empty (body-only FTS row) when the caller has no
       * per-chunk symbol correlation. */
      symbols?: string[];
    }>,
  ): void {
    if (this.vecEnabled && chunks.length > 0) {
      this.ensureVecTable(chunks[0]!.embedding.length);
    }
    const insert = this.db.prepare(
      `INSERT INTO chunks
         (file_path, chunk_text, symbols_text, subtokens_text, start_line, end_line, file_mtime, embedding_provider, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const vecInsert = this.vecTableExists()
      ? this.db.prepare(
          "INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)",
        )
      : null;
    const insertMany = this.db.transaction((rows: typeof chunks) => {
      for (const row of rows) {
        const buf = Buffer.from(row.embedding.buffer);
        const symbols = row.symbols ?? [];
        const info = insert.run(
          row.filePath,
          row.chunkText,
          symbols.join(" "),
          subtokenText(symbols),
          row.startLine,
          row.endLine,
          row.fileMtime,
          row.embeddingProvider,
          buf,
        );
        // Mirror the embedding into the ANN index (rowid = chunk id).
        if (vecInsert && this.vecDim === row.embedding.length) {
          vecInsert.run(BigInt(info.lastInsertRowid), buf);
        }
      }
    });
    insertMany(chunks);
  }

  insertSymbols(
    symbols: Array<CodeSymbol & { filePath: string; fileMtime: number }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO symbols (file_path, name, kind, line, signature, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: typeof symbols) => {
      for (const s of rows) {
        insert.run(
          s.filePath,
          s.name,
          s.kind,
          s.line,
          s.signature,
          s.fileMtime,
        );
      }
    });
    insertMany(symbols);
  }

  querySymbols(opts: {
    name?: string;
    kind?: string;
    pathFilter?: string;
    limit?: number;
  }): SymbolRow[] {
    const { name, kind, pathFilter, limit = 100 } = opts;

    let sql =
      "SELECT file_path, name, kind, line, signature FROM symbols WHERE 1=1";
    const params: (string | number)[] = [];

    if (name) {
      sql += " AND name LIKE ? COLLATE NOCASE";
      params.push(`%${name}%`);
    }
    if (kind) {
      sql += " AND kind = ?";
      params.push(kind);
    }
    if (pathFilter) {
      sql += " AND file_path LIKE ?";
      params.push(`%${pathFilter}%`);
    }

    sql += " ORDER BY file_path, line LIMIT ?";
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      file_path: string;
      name: string;
      kind: string;
      line: number;
      signature: string;
    }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      signature: r.signature,
    }));
  }

  getFileOutline(pathFilter: string): SymbolRow[] {
    const rows = this.db
      .prepare(
        `SELECT file_path, name, kind, line, signature
         FROM symbols
         WHERE file_path LIKE ?
         ORDER BY file_path, line`,
      )
      .all(`%${pathFilter}%`) as Array<{
      file_path: string;
      name: string;
      kind: string;
      line: number;
      signature: string;
    }>;

    return rows.map((r) => ({
      filePath: r.file_path,
      name: r.name,
      kind: r.kind as SymbolKind,
      line: r.line,
      signature: r.signature,
    }));
  }

  insertDefs(rows: Array<DefRow & { fileMtime: number }>): void {
    const insert = this.db.prepare(
      `INSERT INTO defs (symbol, file_path, start_line, end_line, kind, file_mtime)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        insert.run(
          r.symbol,
          r.path,
          r.startLine,
          r.endLine,
          r.kind,
          r.fileMtime,
        );
      }
    });
    insertMany(rows);
  }

  insertRefs(rows: Array<RefRow & { fileMtime: number }>): void {
    const insert = this.db.prepare(
      `INSERT INTO refs (symbol, file_path, line, file_mtime)
       VALUES (?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((items: typeof rows) => {
      for (const r of items) insert.run(r.symbol, r.path, r.line, r.fileMtime);
    });
    insertMany(rows);
  }

  insertCalls(rows: Array<CallRow & { fileMtime: number }>): void {
    const insert = this.db.prepare(
      `INSERT INTO calls (caller, callee, file_path, line, file_mtime)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        insert.run(r.caller, r.callee, r.path, r.line, r.fileMtime);
      }
    });
    insertMany(rows);
  }

  insertImports(rows: Array<ImportRow & { fileMtime: number }>): void {
    const insert = this.db.prepare(
      `INSERT INTO imports (from_path, to_path_or_module, line, file_mtime)
       VALUES (?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((items: typeof rows) => {
      for (const r of items) {
        insert.run(r.fromPath, r.toPathOrModule, r.line, r.fileMtime);
      }
    });
    insertMany(rows);
  }

  /** "Who calls X" — callers of `symbol` across the index. */
  queryCallers(
    symbol: string,
  ): Array<{ caller: string; path: string; line: number }> {
    const rows = this.db
      .prepare(
        `SELECT caller, file_path, line FROM calls WHERE callee = ? ORDER BY file_path, line`,
      )
      .all(symbol) as Array<{
      caller: string;
      file_path: string;
      line: number;
    }>;
    return rows.map((r) => ({
      caller: r.caller,
      path: r.file_path,
      line: r.line,
    }));
  }

  /** "What does X call" — callees invoked from within `caller`. */
  queryCallees(
    caller: string,
  ): Array<{ callee: string; path: string; line: number }> {
    const rows = this.db
      .prepare(
        `SELECT callee, file_path, line FROM calls WHERE caller = ? ORDER BY file_path, line`,
      )
      .all(caller) as Array<{
      callee: string;
      file_path: string;
      line: number;
    }>;
    return rows.map((r) => ({
      callee: r.callee,
      path: r.file_path,
      line: r.line,
    }));
  }

  /** All references to `symbol` across the index (excludes the def site). */
  queryRefs(symbol: string): Array<{ path: string; line: number }> {
    const rows = this.db
      .prepare(
        `SELECT file_path, line FROM refs WHERE symbol = ? ORDER BY file_path, line`,
      )
      .all(symbol) as Array<{ file_path: string; line: number }>;
    return rows.map((r) => ({ path: r.file_path, line: r.line }));
  }

  /** All defs recorded for `symbol` (a def with an empty queryRefs() result
   *  and no incoming queryCallers() is a dead-code candidate). */
  queryDefs(symbol: string): Array<DefRow> {
    const rows = this.db
      .prepare(
        `SELECT symbol, file_path, start_line, end_line, kind FROM defs WHERE symbol = ? ORDER BY file_path, start_line`,
      )
      .all(symbol) as Array<{
      symbol: string;
      file_path: string;
      start_line: number;
      end_line: number;
      kind: string;
    }>;
    return rows.map((r) => ({
      symbol: r.symbol,
      path: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      kind: r.kind,
    }));
  }

  /** All imports recorded for a given source file. */
  queryImports(
    fromPath: string,
  ): Array<{ toPathOrModule: string; line: number }> {
    const rows = this.db
      .prepare(
        `SELECT to_path_or_module, line FROM imports WHERE from_path = ? ORDER BY line`,
      )
      .all(fromPath) as Array<{ to_path_or_module: string; line: number }>;
    return rows.map((r) => ({
      toPathOrModule: r.to_path_or_module,
      line: r.line,
    }));
  }

  defCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM defs").get() as {
      n: number;
    };
    return row.n;
  }

  /** FTS search for a symbol name — used by code_references. */
  searchFtsForName(name: string, topK: number): SearchResult[] {
    // Wrap in quotes for exact phrase match, escape any internal quotes
    const escaped = name.replace(/"/g, '""');
    try {
      const rows = this.db
        .prepare(
          `SELECT c.id, c.file_path, c.chunk_text, c.start_line, c.end_line,
                  c.file_mtime, c.embedding_provider,
                  bm25(chunks_fts, ${BM25_SYMBOLS_WEIGHT}, ${BM25_SUBTOKENS_WEIGHT}, ${BM25_BODY_WEIGHT}) AS score
           FROM chunks_fts
           JOIN chunks c ON c.id = chunks_fts.rowid
           WHERE chunks_fts MATCH ?
           ORDER BY score
           LIMIT ?`,
        )
        .all(`"${escaped}"`, topK) as Array<{
        id: number;
        file_path: string;
        chunk_text: string;
        start_line: number;
        end_line: number;
        file_mtime: number;
        embedding_provider: string;
        score: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        filePath: row.file_path,
        chunkText: row.chunk_text,
        startLine: row.start_line,
        endLine: row.end_line,
        fileMtime: row.file_mtime,
        embeddingProvider: row.embedding_provider,
        score: -row.score,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Vector search entry point. Uses the sqlite-vec ANN index when it's built
   * and populated (sub-linear); otherwise falls back to the brute-force cosine
   * scan. Both use cosine distance, so scores are comparable across the two.
   */
  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    if (this.vecTableExists()) {
      try {
        const rows = this.db
          .prepare(
            `SELECT c.id, c.file_path, c.chunk_text, c.start_line, c.end_line,
                    c.file_mtime, c.embedding_provider, v.distance
             FROM vec_chunks v
             JOIN chunks c ON c.id = v.rowid
             WHERE v.embedding MATCH ?
             ORDER BY v.distance
             LIMIT ?`,
          )
          .all(Buffer.from(queryEmbedding.buffer), topK) as Array<{
          id: number;
          file_path: string;
          chunk_text: string;
          start_line: number;
          end_line: number;
          file_mtime: number;
          embedding_provider: string;
          distance: number;
        }>;
        if (rows.length > 0) {
          return rows.map((row) => ({
            id: row.id,
            filePath: row.file_path,
            chunkText: row.chunk_text,
            startLine: row.start_line,
            endLine: row.end_line,
            fileMtime: row.file_mtime,
            embeddingProvider: row.embedding_provider,
            score: 1 - row.distance, // cosine distance → cosine similarity
          }));
        }
        // Table exists but empty (index predates ANN) → brute-force below.
      } catch {
        // ANN query failed for any reason → brute-force below.
      }
    }
    return this.searchBrute(queryEmbedding, topK);
  }

  /** Brute-force cosine similarity scan — fallback / <50k chunks. */
  searchBrute(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, file_path, chunk_text, start_line, end_line, file_mtime,
                embedding_provider, embedding FROM chunks`,
      )
      .all() as Array<{
      id: number;
      file_path: string;
      chunk_text: string;
      start_line: number;
      end_line: number;
      file_mtime: number;
      embedding_provider: string;
      embedding: Buffer;
    }>;

    const scored = rows.map((row) => {
      const vec = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      const score = cosineSimilarity(queryEmbedding, vec);
      return {
        id: row.id,
        filePath: row.file_path,
        chunkText: row.chunk_text,
        startLine: row.start_line,
        endLine: row.end_line,
        fileMtime: row.file_mtime,
        embeddingProvider: row.embedding_provider,
        score,
      };
    });

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** FTS5 fallback when no embedding provider is available. */
  searchFts(query: string, topK: number): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.file_path, c.chunk_text, c.start_line, c.end_line,
                c.file_mtime, c.embedding_provider,
                bm25(chunks_fts, ${BM25_SYMBOLS_WEIGHT}, ${BM25_SUBTOKENS_WEIGHT}, ${BM25_BODY_WEIGHT}) AS score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(query, topK) as Array<{
      id: number;
      file_path: string;
      chunk_text: string;
      start_line: number;
      end_line: number;
      file_mtime: number;
      embedding_provider: string;
      score: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      filePath: row.file_path,
      chunkText: row.chunk_text,
      startLine: row.start_line,
      endLine: row.end_line,
      fileMtime: row.file_mtime,
      embeddingProvider: row.embedding_provider,
      score: -row.score,
    }));
  }

  chunkCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as {
      n: number;
    };
    return row.n;
  }

  fileCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT file_path) as n FROM chunks")
      .get() as { n: number };
    return row.n;
  }

  symbolCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) as n FROM symbols").get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
