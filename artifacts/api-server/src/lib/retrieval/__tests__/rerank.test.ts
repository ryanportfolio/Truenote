import { describe, expect, it } from "vitest";
import type { CohereClient } from "cohere-ai";
import { rerankWithCohere } from "../rerank.js";

describe("rerankWithCohere", () => {
  it("redacts the query and documents before the Cohere boundary", async () => {
    let captured:
      | { model: string; query: string; documents: string[]; topN: number }
      | undefined;
    const client = {
      rerank: async (request: {
        model: string;
        query: string;
        documents: string[];
        topN: number;
      }) => {
        captured = request;
        return { results: [{ index: 0, relevanceScore: 0.9 }] };
      }
    } as unknown as CohereClient;

    const result = await rerankWithCohere(
      {
        question: "Find csr@example.com from 192.0.2.10",
        documents: ["Call 212-555-0198 about SSN 123-45-6789"]
      },
      { client }
    );

    expect(captured).toEqual({
      model: "rerank-english-v3.0",
      query: "Find [REDACTED_PII_EMAIL] from [REDACTED_PII_IP_ADDRESS]",
      documents: ["Call [REDACTED_PII_PHONE] about SSN [REDACTED_PII_US_SSN]"],
      topN: 1
    });
    expect(result.results[0]).toEqual({ index: 0, relevance_score: 0.9 });
  });
});
