import { describe, expect, it } from "vitest";
import {
  ComplianceProviderError,
  embedComplianceTexts,
  rerankComplianceTexts
} from "../providers.js";

function recordingFetch(responses: Array<{ status: number; body: unknown }>) {
  const requests: Array<{ url: string; body: any }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    const next = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

const ZDR = { zdr: true, data_collection: "deny", allow_fallbacks: false };

describe("compliance provider calls", () => {
  it("embeds through OpenRouter pinned to a ZDR endpoint", async () => {
    const { fetch, requests } = recordingFetch([
      { status: 200, body: { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } }
    ]);
    const vectors = await embedComplianceTexts(["first", "second"], "document", {}, { fetch, apiKey: "k" });
    expect(vectors).toEqual([[1, 0], [0, 1]]);
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(requests[0]!.body).toMatchObject({
      model: "openai/text-embedding-3-small",
      provider: { only: ["azure"], ...ZDR }
    });
  });

  it("reranks through OpenRouter pinned to a ZDR endpoint and runs the question through the firewall", async () => {
    const { fetch, requests } = recordingFetch([
      { status: 200, body: { results: [{ index: 0, relevance_score: 0.2 }, { index: 1, relevance_score: 0.9 }] } }
    ]);
    const results = await rerankComplianceTexts(
      "Who owns ops@example.com?",
      ["a", "b"],
      8,
      {},
      { fetch, apiKey: "k" }
    );
    expect(results).toEqual([{ index: 1, score: 0.9 }, { index: 0, score: 0.2 }]);
    expect(requests[0]!.url).toBe("https://openrouter.ai/api/v1/rerank");
    expect(requests[0]!.body).toMatchObject({
      model: "qwen/qwen3-reranker-8b",
      top_n: 2,
      provider: { only: ["fireworks"], ...ZDR }
    });
    expect(requests[0]!.body.query).not.toContain("ops@example.com");
  });

  it("fails instead of degrading when the provider refuses, without echoing the response", async () => {
    const { fetch } = recordingFetch([
      { status: 404, body: { error: { message: "No endpoints found matching your data policy: secret text" } } }
    ]);
    const failure = await rerankComplianceTexts("q", ["a"], 8, {}, { fetch, apiKey: "k" }).catch((error) => error);
    expect(failure).toBeInstanceOf(ComplianceProviderError);
    expect(failure.message).toBe("rerank returned HTTP 404");
  });

  it("rejects a response with an out-of-range index", async () => {
    const { fetch } = recordingFetch([{ status: 200, body: { results: [{ index: 5, relevance_score: 1 }] } }]);
    await expect(rerankComplianceTexts("q", ["a"], 8, {}, { fetch, apiKey: "k" })).rejects.toBeInstanceOf(
      ComplianceProviderError
    );
  });
});
