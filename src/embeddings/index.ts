import { LmStudioProvider } from "./lm-studio.js";
import type { EmbeddingProvider, ProviderMeta } from "./types.js";

export type { EmbeddingProvider, ProviderMeta };

/**
 * Returns the first available provider in priority order.
 * Provider is chosen once at index-time and must match the stored ProviderMeta —
 * mixing providers across the same index produces incomparable vectors.
 */
export async function detectProvider(options: {
  lmStudioUrl?: string;
  lmStudioModel?: string;
}): Promise<EmbeddingProvider> {
  const lmStudio = new LmStudioProvider({
    baseUrl: options.lmStudioUrl,
    model: options.lmStudioModel,
  });

  if (await lmStudio.isAvailable()) return lmStudio;

  throw new Error(
    "No embedding provider available. Start LM Studio with an embedding model loaded " +
      "(default: text-embedding-nomic-embed-text-v1.5 on localhost:1234).",
  );
}

export function providerFromMeta(meta: ProviderMeta): EmbeddingProvider {
  if (meta.name === "lm-studio") {
    return new LmStudioProvider({ dim: meta.dim });
  }
  throw new Error(
    `Unknown provider in index metadata: "${meta.name}". Re-index to rebuild.`,
  );
}
