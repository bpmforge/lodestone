import { CodeRankEmbedProvider } from "./coderank.js";
import { LmStudioProvider } from "./lm-studio.js";
import type { EmbeddingProvider, ProviderMeta } from "./types.js";

export type { EmbeddingProvider, ProviderMeta };

/**
 * Returns the first available provider in priority order:
 *
 *   1. CodeRankEmbed (default, code-specialized — see coderank.ts)
 *   2. nomic-embed-text via LM Studio (fallback / explicit opt-in)
 *
 * Provider is chosen once at index-time and its `name` is stored in
 * ProviderMeta. `providerFromMeta`/callers must match that stored name at
 * query time — mixing providers (or models) across the same index produces
 * incomparable vectors, so `coderank-embed` and `lm-studio` are DIFFERENT
 * names precisely so a model swap trips the mismatch guard (see
 * search.ts/mcp.ts) instead of silently mixing vector spaces, even though
 * both currently embed at the same dimension (768).
 */
export async function detectProvider(options: {
  lmStudioUrl?: string;
  lmStudioModel?: string;
  codeRankModel?: string;
}): Promise<EmbeddingProvider> {
  const codeRank = new CodeRankEmbedProvider({
    baseUrl: options.lmStudioUrl,
    model: options.codeRankModel,
  });
  if (await codeRank.isAvailable()) return codeRank;

  const lmStudio = new LmStudioProvider({
    baseUrl: options.lmStudioUrl,
    model: options.lmStudioModel,
  });
  if (await lmStudio.isAvailable()) return lmStudio;

  throw new Error(
    "No embedding provider available. Start LM Studio with an embedding model loaded " +
      "(default: CodeRankEmbed; fallback: text-embedding-nomic-embed-text-v1.5) on localhost:1234.",
  );
}

export function providerFromMeta(meta: ProviderMeta): EmbeddingProvider {
  if (meta.name === "coderank-embed") {
    return new CodeRankEmbedProvider({ dim: meta.dim });
  }
  if (meta.name === "lm-studio") {
    return new LmStudioProvider({ dim: meta.dim });
  }
  throw new Error(
    `Unknown provider in index metadata: "${meta.name}". Re-index to rebuild.`,
  );
}
