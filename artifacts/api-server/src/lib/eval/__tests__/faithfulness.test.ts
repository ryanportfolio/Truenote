import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { judgeFaithfulness, scoreClaims } from "../faithfulness.js";
import { expectedDocRank } from "../runner.js";
import type { RetrievalChunk } from "../../retrieval/query.js";

function chunk(content: string): RetrievalChunk {
  return {
    id: "c1",
    content,
    documentVersionId: "dv1",
    documentId: "doc-a",
    versionNumber: 1,
    programId: "p1",
    docTitle: "Test Doc",
    metadata: null,
    relevanceScore: 0.9
  } as RetrievalChunk;
}

describe("judgeFaithfulness provider-input firewall", () => {
  it("redacts sensitive excerpt and answer content before the prompt reaches the provider", async () => {
    const sent: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fakeClient = {
      beta: {
        chat: {
          completions: {
            parse: async (request: { messages: Array<{ role: string; content: string }> }) => {
              sent.push(request);
              return { choices: [{ message: { parsed: { claims: [] } } }] };
            }
          }
        }
      }
    } as unknown as OpenAI;

    await judgeFaithfulness(
      {
        answer: "Call the member back at (415) 555-0132 to confirm.",
        chunks: [chunk("Member SSN on file is 456-45-6789 and email is member@example.com.")]
      },
      { client: fakeClient }
    );

    expect(sent).toHaveLength(1);
    const userPrompt = sent[0].messages.find((m) => m.role === "user")?.content ?? "";
    expect(userPrompt).not.toContain("456-45-6789");
    expect(userPrompt).not.toContain("member@example.com");
    expect(userPrompt).not.toContain("(415) 555-0132");
    expect(userPrompt).toContain("[REDACTED_PII_EMAIL]");
    expect(userPrompt).toContain("[REDACTED_PII_PHONE]");
    // Non-sensitive excerpt structure survives so the judge still sees sources.
    expect(userPrompt).toContain("SOURCE [S1]");
    expect(userPrompt).toContain("Test Doc");
  });
});

describe("scoreClaims", () => {
  it("computes the supported percentage and lists unsupported claims", () => {
    const result = scoreClaims([
      { claim: "The fee is $25", supported: true },
      { claim: "Refunds take 5 days", supported: false },
      { claim: "Plan X includes voicemail", supported: true },
      { claim: "The deadline is March 1", supported: false }
    ]);
    expect(result.faithfulnessPct).toBe(50);
    expect(result.unsupportedClaims).toEqual([
      "Refunds take 5 days",
      "The deadline is March 1"
    ]);
  });

  it("returns null pct for an answer with no factual claims", () => {
    const result = scoreClaims([]);
    expect(result.faithfulnessPct).toBeNull();
    expect(result.unsupportedClaims).toEqual([]);
  });

  it("scores a fully supported answer at 100", () => {
    const result = scoreClaims([{ claim: "a", supported: true }]);
    expect(result.faithfulnessPct).toBe(100);
    expect(result.unsupportedClaims).toEqual([]);
  });
});

describe("expectedDocRank", () => {
  const ranked = [
    { chunkId: "c1", documentId: "doc-a" },
    { chunkId: "c2", documentId: "doc-b" },
    { chunkId: "c3", documentId: "doc-a" },
    { chunkId: "c4", documentId: null }
  ];

  it("returns the 1-based rank of the first chunk from the expected doc", () => {
    expect(expectedDocRank(ranked, "doc-a")).toBe(1);
    expect(expectedDocRank(ranked, "doc-b")).toBe(2);
  });

  it("returns null when the expected doc is absent", () => {
    expect(expectedDocRank(ranked, "doc-z")).toBeNull();
    expect(expectedDocRank([], "doc-a")).toBeNull();
  });
});
