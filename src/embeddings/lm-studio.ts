import type { EmbeddingProvider } from "./types.js";

export class LmStudioProvider implements EmbeddingProvider {
  readonly name = "lm-studio";
  readonly dim: number;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    options: { baseUrl?: string; model?: string; dim?: number } = {},
  ) {
    this.baseUrl = options.baseUrl ?? "http://localhost:1234";
    this.model = options.model ?? "text-embedding-nomic-embed-text-v1.5";
    this.dim = options.dim ?? 768;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return false;
      // LM Studio can have a *different* embedding model loaded (e.g.
      // CodeRankEmbed) while still answering /v1/models — a bare res.ok
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
      throw new Error(`LM Studio embedding failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return data.data.map((d) => d.embedding);
  }
}
