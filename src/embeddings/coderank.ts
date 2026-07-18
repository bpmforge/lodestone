import type { EmbeddingProvider } from "./types.js";

/**
 * CodeRankEmbed (nomic-ai/CodeRankEmbed, 137M params, MIT) — a
 * code-specialized embedder that beats general text embedders (e.g.
 * nomic-embed-text) on NL→code retrieval. Served the same way as any other
 * LM Studio model: the OpenAI-compatible /v1/embeddings endpoint. Default
 * code embedder as of W3-07 — see README "Embeddings" section.
 *
 * DEFERRED-TO-LIVE (no model download available in this environment — see
 * PR handoff): `dim` (768, assumed from the model card's Arctic-Embed-M
 * lineage) and the LM Studio model id string below are both best guesses
 * and MUST be confirmed against the actually-loaded GGUF before relying on
 * a live index. Both are override-able via constructor options / env so a
 * wrong guess doesn't require a code change to fix.
 *
 * DEFERRED-TO-LIVE: CodeRankEmbed's model card documents an asymmetric
 * instruction prefix — queries should be prefixed with
 * "Represent this query for searching relevant code: " while documents
 * (indexed chunks) are NOT prefixed. This provider does not apply that
 * prefix: `EmbeddingProvider.embed()` is a symmetric text[]→vector[][]
 * interface shared by every provider, and the query-side call lives in
 * `search.ts` / `search/query.ts` (outside this ticket's write_scope).
 * Retrieval will work without the prefix but recall on the query side may
 * be lower than the model's benchmarked numbers until that's wired in.
 * nomic-embed-text has the same gap today (pre-existing, not introduced by
 * this ticket).
 */
export class CodeRankEmbedProvider implements EmbeddingProvider {
  readonly name = "coderank-embed";
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    options: { baseUrl?: string; model?: string; dim?: number } = {},
  ) {
    this.baseUrl = options.baseUrl ?? "http://localhost:1234";
    this.model = options.model ?? "text-embedding-coderankembed";
    this.dim = options.dim ?? 768;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      // LM Studio can have a *different* embedding model loaded (e.g.
      // nomic-embed-text) while still answering /v1/models — a bare res.ok
      // check would report "available" and then fail at embed() time.
      // Confirm this specific model id is the one currently loaded.
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).some((m) => m.id === this.model);
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`CodeRankEmbed embedding failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}
