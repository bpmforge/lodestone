import fs from "node:fs";
import type { CodeSearchDb } from "../db.js";
import { chunkFile } from "../chunker/index.js";
import { expand, loadOntology, type ExpandResult } from "../ontology/index.js";
import { isCrossFileGraphReliable } from "../search/graphReliability.js";
import { symbolsInRange } from "../search/symbolsInRange.js";

/**
 * Evidence-packet builder (docs/LODESTONE_DESIGN.md §6): the contract
 * between Tier-1 (deterministic retrieval, this repo) and Tier-2/3 (the LLM
 * tier — CodeReckon W5-02 consumes this). A `Finding` — the shape a
 * deterministic Tier-0 scanner (bpm-rulepacks) or a query() Cluster
 * primary emits — in, a few-KB bundle out: the finding's chunk, its
 * call-graph neighborhood, relevant config refs, and the concept it maps
 * to, everything with path:line.
 */

export interface Finding {
  path: string;
  line: number;
  endLine?: number;
  ruleId?: string;
  message?: string;
  /** Concept key from a rule's metadata.concept (bpm-rulepacks convention,
   *  see MASTER_PROMPT.md guardrail 1). Used directly as the expand() seed
   *  when present, ahead of message/ruleId. */
  concept?: string;
}

export interface EvidenceChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  /** File path + enclosing symbol chain, e.g.
   *  "src/auth.ts > class UserService > authenticate" — only set when the
   *  cAST chunker (not the window fallback) produced this chunk. */
  header?: string;
  symbolChain?: string[];
}

export type NeighborRelation = "caller" | "callee";

export interface CallGraphNeighbor {
  symbol: string;
  path: string;
  line: number;
  relation: NeighborRelation;
}

export interface ConfigRef {
  symbol: string;
  path: string;
  line: number;
}

/** ExpandResult plus the union of matched concepts' CWE anchors — the
 *  ontology carries `cwe` "for report traceability" (LODESTONE_DESIGN.md
 *  §4 item 5); the LLM tier / audit report needs it, so it's surfaced here
 *  rather than dropped along with the rest of `expand()`'s output. */
export interface ConceptMapping extends ExpandResult {
  cwe: number[];
}

export interface EvidencePacket {
  finding: Finding;
  chunk: EvidenceChunk;
  callers: CallGraphNeighbor[];
  callees: CallGraphNeighbor[];
  /** Refs to this finding's own symbols landing in a config-like file
   *  (.yml/.yaml/.json/.toml/.ini/.cfg/.conf/.env). Config files aren't in
   *  indexer.ts's DEFAULT_INCLUDE glob today, so this is empty-by-default
   *  until config-file indexing lands — the classifier itself is exercised
   *  directly in packet.test.ts via CodeSearchDb.insertRefs(). */
  configRefs: ConfigRef[];
  concept: ConceptMapping;
  /** See graphReliability.ts. False => an empty callers/refs list here is
   *  NOT evidence the finding's symbol is dead/unused repo-wide, only that
   *  no same-file usage exists (W3-04 regex-tier caveat) — surface this to
   *  the LLM tier rather than silently treating "no callers" as "unused". */
  crossFileGraphReliable: boolean;
}

const CONFIG_FILE_RE = /\.(ya?ml|json|toml|ini|cfg|conf|env)$/i;
const MAX_NEIGHBORS = 30;
const RAW_SLICE_CONTEXT_LINES = 5;

// loadOntology() re-parses ontology/concepts.yaml from disk (see
// ontology/index.ts — it has no internal cache, unlike expand()'s default
// path); cache it here so repeated evidencePacket() calls in one process
// don't re-read/re-parse the YAML every time.
let cachedOntology: ReturnType<typeof loadOntology> | undefined;

/** Union of CWE anchors for the concepts `expand()` matched. */
function conceptCwe(matchedConceptKeys: string[]): number[] {
  if (matchedConceptKeys.length === 0) return [];
  if (!cachedOntology) cachedOntology = loadOntology();
  const cwe = new Set<number>();
  for (const key of matchedConceptKeys) {
    const concept = cachedOntology.concepts.find((c) => c.key === key);
    if (concept) for (const n of concept.cwe) cwe.add(n);
  }
  return [...cwe];
}

/**
 * Locate the chunk covering `finding.line` by re-running the same cAST
 * chunker used at index time against the finding's file on disk. There is
 * no chunk-by-path/line lookup on CodeSearchDb — chunks aren't indexed by
 * location, and `header`/`symbolChain` aren't persisted to the chunks table
 * at all (see chunker/types.ts) — so this is the only way to recover them.
 * Requires the finding's file to still be present on disk at the same path
 * the index used (normalize `finding.path` to the indexed absolute path
 * before calling). Falls back to a small raw slice around the line if the
 * file is missing or no chunk covers it.
 */
async function findingChunk(finding: Finding): Promise<EvidenceChunk> {
  let content: string;
  try {
    content = fs.readFileSync(finding.path, "utf-8");
  } catch {
    return {
      path: finding.path,
      startLine: finding.line,
      endLine: finding.endLine ?? finding.line,
      text: "",
    };
  }

  const chunks = await chunkFile(content, finding.path);
  const hit = chunks.find(
    (c) => finding.line >= c.startLine && finding.line <= c.endLine,
  );
  if (hit) {
    return {
      path: finding.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      text: hit.text,
      header: hit.header,
      symbolChain: hit.symbolChain,
    };
  }

  // No chunk covers the line (e.g. finding.line past EOF) — a tight raw
  // slice keeps the packet non-empty instead of failing.
  const lines = content.split("\n");
  const start = Math.max(1, finding.line - RAW_SLICE_CONTEXT_LINES);
  const end = Math.min(lines.length, finding.line + RAW_SLICE_CONTEXT_LINES);
  return {
    path: finding.path,
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join("\n"),
  };
}

export async function evidencePacket(
  db: CodeSearchDb,
  finding: Finding,
): Promise<EvidencePacket> {
  const chunk = await findingChunk(finding);

  const ownSymbols = symbolsInRange(
    db,
    finding.path,
    chunk.startLine,
    chunk.endLine,
  ).map((s) => s.name);

  const callers: CallGraphNeighbor[] = [];
  const callees: CallGraphNeighbor[] = [];
  const configRefs: ConfigRef[] = [];
  const seen = new Set<string>();

  const add = (
    key: string,
    push: () => void,
    cap: { length: number },
  ): void => {
    if (cap.length >= MAX_NEIGHBORS || seen.has(key)) return;
    seen.add(key);
    push();
  };

  for (const name of ownSymbols) {
    for (const c of db.queryCallers(name)) {
      add(
        `caller:${c.path}:${c.line}:${name}`,
        () => {
          callers.push({
            symbol: name,
            path: c.path,
            line: c.line,
            relation: "caller",
          });
        },
        callers,
      );
    }
    for (const c of db.queryCallees(name)) {
      add(
        `callee:${c.path}:${c.line}:${c.callee}`,
        () => {
          callees.push({
            symbol: c.callee,
            path: c.path,
            line: c.line,
            relation: "callee",
          });
        },
        callees,
      );
    }
    for (const ref of db.queryRefs(name)) {
      if (!CONFIG_FILE_RE.test(ref.path)) continue;
      add(
        `config:${ref.path}:${ref.line}:${name}`,
        () => {
          configRefs.push({ symbol: name, path: ref.path, line: ref.line });
        },
        configRefs,
      );
    }
  }

  const conceptSeed =
    finding.concept ??
    finding.message ??
    finding.ruleId ??
    ownSymbols.join(" ");
  const expanded = expand(conceptSeed);
  const concept: ConceptMapping = {
    ...expanded,
    cwe: conceptCwe(expanded.concepts),
  };

  return {
    finding,
    chunk,
    callers,
    callees,
    configRefs,
    concept,
    crossFileGraphReliable: isCrossFileGraphReliable(finding.path),
  };
}
