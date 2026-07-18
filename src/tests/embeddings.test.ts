import { describe, it, expect, afterEach, vi } from "vitest";
import { CodeRankEmbedProvider } from "../embeddings/coderank.js";
import { LmStudioProvider } from "../embeddings/lm-studio.js";
import { detectProvider, providerFromMeta } from "../embeddings/index.js";
import { search } from "../search.js";

/**
 * W3-07: CodeRankEmbed becomes the DEFAULT code embedder (nomic-embed-text
 * via LM Studio stays selectable). No live model download is available in
 * this environment (see PR handoff) — these tests cover the plumbing that
 * doesn't require one: default selection order, provider-name resolution,
 * and the provider-sticky guard (an index built with one provider name
 * must never be queried with a mismatched provider's vectors — it falls
 * back to FTS5 instead of silently mixing vector spaces).
 */

function mockFetchModelsThen(loadedModelIds: string[]) {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/v1/models")) {
      return {
        ok: true,
        json: async () => ({ data: loadedModelIds.map((id) => ({ id })) }),
      } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("providerFromMeta (network-free provider-name resolution)", () => {
  it('resolves "coderank-embed" — the new default — to a CodeRankEmbedProvider', () => {
    const provider = providerFromMeta({ name: "coderank-embed", dim: 768 });
    expect(provider).toBeInstanceOf(CodeRankEmbedProvider);
    expect(provider.name).toBe("coderank-embed");
    expect(provider.dim).toBe(768);
  });

  it('still resolves "lm-studio" — an index built before this ticket keeps working', () => {
    const provider = providerFromMeta({ name: "lm-studio", dim: 768 });
    expect(provider).toBeInstanceOf(LmStudioProvider);
    expect(provider.name).toBe("lm-studio");
  });

  it("throws (never silently substitutes) for an unknown provider name", () => {
    expect(() =>
      providerFromMeta({ name: "some-other-embedder", dim: 768 }),
    ).toThrow(/Unknown provider/);
  });
});

describe("detectProvider (default selection order)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("picks CodeRankEmbed when it is the model actually loaded in LM Studio", async () => {
    global.fetch = mockFetchModelsThen(["text-embedding-coderankembed"]) as any;
    const provider = await detectProvider({});
    expect(provider.name).toBe("coderank-embed");
  });

  it("falls back to nomic-embed-text when only it is loaded (CodeRankEmbed unavailable)", async () => {
    global.fetch = mockFetchModelsThen([
      "text-embedding-nomic-embed-text-v1.5",
    ]) as any;
    const provider = await detectProvider({});
    expect(provider.name).toBe("lm-studio");
  });

  it("does NOT mis-select CodeRankEmbed just because a server answers /v1/models with an unrelated model loaded", async () => {
    global.fetch = mockFetchModelsThen(["some-unrelated-chat-model"]) as any;
    await expect(detectProvider({})).rejects.toThrow(
      /No embedding provider available/,
    );
  });

  it("throws when no LM Studio server is reachable at all", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;
    await expect(detectProvider({})).rejects.toThrow(
      /No embedding provider available/,
    );
  });
});

describe("provider-sticky guard (search() must never mix vector spaces)", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it(
    "an index built with the OLD default (lm-studio) queried while the NEW " +
      "default (coderank-embed) is active in memory embeds the query with " +
      "the META-MATCHED provider (lm-studio), never the mismatched active " +
      "one — proven by inspecting which model the embed POST actually used",
    async () => {
      const embedCalls: string[] = [];
      global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
        if (typeof url === "string" && url.endsWith("/v1/embeddings")) {
          const body = JSON.parse(String(init?.body));
          embedCalls.push(body.model);
          return {
            ok: true,
            json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          } as Response;
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as any;

      const vecHit = {
        id: 1,
        filePath: "vec.ts",
        chunkText: "vec hit",
        startLine: 1,
        endLine: 1,
        fileMtime: 0,
        embeddingProvider: "lm-studio",
        score: 1,
      };
      const db: any = {
        // Index was built with the OLD default provider.
        getProviderMeta: () => ({ name: "lm-studio", dim: 768 }),
        searchFts: () => [],
        search: () => [vecHit],
      };
      // Caller's in-memory provider is now the NEW default (mismatched name
      // — this is exactly the post-upgrade state: the process picked
      // coderank-embed via detectProvider(), but this particular index on
      // disk still predates the default flip).
      const mismatchedActiveProvider = new CodeRankEmbedProvider({ dim: 768 });

      const res = await search("q", db, mismatchedActiveProvider, {});

      // The embed request that actually went out used nomic-embed-text (the
      // lm-studio provider's default model) — never CodeRankEmbed's model —
      // proving search() reconstructed the provider matching the STORED
      // index meta rather than trusting the mismatched active provider.
      expect(embedCalls).toEqual(["text-embedding-nomic-embed-text-v1.5"]);
      expect(res).toEqual([vecHit]);
    },
  );

  it("providerFromMeta always reconstructs the STORED name, never the caller's active provider's name", () => {
    const meta = { name: "coderank-embed", dim: 768 };
    const reconstructed = providerFromMeta(meta);
    expect(reconstructed.name).toBe(meta.name);
    expect(reconstructed).not.toBeInstanceOf(LmStudioProvider);
  });
});
