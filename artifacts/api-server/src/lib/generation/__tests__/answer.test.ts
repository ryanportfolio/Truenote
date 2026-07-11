import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { AnswerPayload } from "../answer.js";
import { generateAnswer } from "../answer.js";
import { APPROVED_MODEL_ROUTES, DEFAULT_MODEL_ROUTE } from "../model-routing.js";

// GPT-5.4 Nano — the second approved route, used to exercise chain cascade.
const NANO_ROUTE = APPROVED_MODEL_ROUTES.find(
  (route) => route.id === "gpt-5.4-nano-azure-nitro"
)!;

interface CapturedRequest {
  model: string;
  provider?: unknown;
  reasoning_effort?: string;
  temperature?: number;
}

function stubClient(parsed: AnswerPayload | null, requests: CapturedRequest[]): OpenAI {
  return {
    beta: {
      chat: {
        completions: {
          parse: async (request: CapturedRequest) => {
            requests.push(request);
            return { choices: [{ message: { parsed } }] };
          }
        }
      }
    }
  } as unknown as OpenAI;
}

function throwingClient(requests: CapturedRequest[]): OpenAI {
  return {
    beta: {
      chat: {
        completions: {
          parse: async (request: CapturedRequest) => {
            requests.push(request);
            throw new Error("model unavailable");
          }
        }
      }
    }
  } as unknown as OpenAI;
}

/** Client whose per-request behavior is keyed by model id: an AnswerPayload to
 *  return it parsed, "throw" to simulate a request error, null for no parse. */
function routingClient(
  behaviors: Record<string, AnswerPayload | "throw" | null>,
  requests: CapturedRequest[]
): OpenAI {
  return {
    beta: {
      chat: {
        completions: {
          parse: async (request: CapturedRequest) => {
            requests.push(request);
            const behavior = behaviors[request.model];
            if (behavior === "throw") throw new Error("model unavailable");
            return { choices: [{ message: { parsed: behavior ?? null } }] };
          }
        }
      }
    }
  } as unknown as OpenAI;
}

const chunks = [
  {
    id: "chunk-1",
    content: "The cancellation fee is $25.",
    documentVersionId: "version-1",
    documentId: "document-1",
    versionNumber: 1,
    programId: "program-1",
    docTitle: "Cancellation Policy",
    metadata: {},
    relevanceScore: 0.9
  }
];

const answer: AnswerPayload = {
  answer: "The cancellation fee is **$25** [chunk-1].",
  sources: [
    {
      chunk_id: "chunk-1",
      doc_title: "Untrusted title",
      excerpt: "Untrusted excerpt"
    }
  ],
  refused: false,
  confidence: "high"
};

describe("generateAnswer provider fallback", () => {
  it("uses the selected approved OpenRouter route", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const fallbackRequests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: stubClient(answer, primaryRequests),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(primaryRequests).toEqual([
      expect.objectContaining({
        model: "openai/gpt-5.6-luna",
        reasoning_effort: "low",
        provider: {
          only: ["openai"],
          zdr: true,
          data_collection: "deny",
          require_parameters: true,
          allow_fallbacks: false
        }
      })
    ]);
    expect(primaryRequests[0]?.temperature).toBeUndefined();
    expect(fallbackRequests).toEqual([]);
    expect(result.payload.refused).toBe(false);
    expect(result.generationPath).toBe("primary");
  });

  it("retries with OpenAI GPT-5.6 Luna at low reasoning when the primary request throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primaryRequests: CapturedRequest[] = [];
    const fallbackRequests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: throwingClient(primaryRequests),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(primaryRequests[0]?.model).toBe("openai/gpt-5.6-luna");
    expect(fallbackRequests).toEqual([
      expect.objectContaining({
        model: "gpt-5.6-luna",
        reasoning_effort: "low"
      })
    ]);
    expect(fallbackRequests[0]?.provider).toBeUndefined();
    expect(fallbackRequests[0]?.temperature).toBeUndefined();
    expect(result.payload.refused).toBe(false);
    expect(result.generationPath).toBe("fallback");
    warning.mockRestore();
  });

  it("retries with OpenAI when the primary response is not parseable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallbackRequests: CapturedRequest[] = [];

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: stubClient(null, []),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(fallbackRequests[0]?.model).toBe("gpt-5.6-luna");
    warning.mockRestore();
  });

  it("retries when the primary answer cites an unknown chunk", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallbackRequests: CapturedRequest[] = [];
    const invalidAnswer: AnswerPayload = {
      ...answer,
      answer: "The cancellation fee is **$25** [unknown-chunk].",
      sources: [{ chunk_id: "unknown-chunk", doc_title: "Made up", excerpt: "Made up" }]
    };

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: stubClient(invalidAnswer, []),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(fallbackRequests[0]?.model).toBe("gpt-5.6-luna");
    expect(result.payload.refused).toBe(false);
    warning.mockRestore();
  });

  it("retries when the primary answer omits an inline citation", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fallbackRequests: CapturedRequest[] = [];

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: stubClient({ ...answer, answer: "The cancellation fee is **$25**." }, []),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(fallbackRequests[0]?.model).toBe("gpt-5.6-luna");
    warning.mockRestore();
  });

  it("keeps a valid primary refusal without calling the backup", async () => {
    const fallbackRequests: CapturedRequest[] = [];
    const refusal: AnswerPayload = {
      answer: "I couldn't find this in the knowledge base.",
      sources: [],
      refused: true,
      confidence: "low"
    };

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: stubClient(refusal, []),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [DEFAULT_MODEL_ROUTE]
      }
    );

    expect(fallbackRequests).toEqual([]);
    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("primary");
  });

  it("records a failed fallback and returns a safe refusal", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: throwingClient([]),
        fallbackClient: throwingClient([]),
        primaryRoute: DEFAULT_MODEL_ROUTE
      }
    );

    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("fallback-failed");
    warning.mockRestore();
  });

  it("cascades to the next route in the chain when a route errors", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primaryRequests: CapturedRequest[] = [];
    const fallbackRequests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": "throw", "openai/gpt-5.6-luna": answer },
          primaryRequests
        ),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [NANO_ROUTE, DEFAULT_MODEL_ROUTE]
      }
    );

    expect(primaryRequests.map((request) => request.model)).toEqual([
      "openai/gpt-5.4-nano:nitro",
      "openai/gpt-5.6-luna"
    ]);
    // Second route in the chain answered — the direct OpenAI backup is untouched.
    expect(fallbackRequests).toEqual([]);
    expect(result.payload.refused).toBe(false);
    expect(result.generationPath).toBe("fallback");
    warning.mockRestore();
  });

  it("stops at the first valid refusal without cascading or calling the backup", async () => {
    const primaryRequests: CapturedRequest[] = [];
    const fallbackRequests: CapturedRequest[] = [];
    const refusal: AnswerPayload = {
      answer: "I couldn't find this in the knowledge base.",
      sources: [],
      refused: true,
      confidence: "low"
    };

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": refusal, "openai/gpt-5.6-luna": answer },
          primaryRequests
        ),
        fallbackClient: stubClient(answer, fallbackRequests),
        routeChain: [NANO_ROUTE, DEFAULT_MODEL_ROUTE]
      }
    );

    // A grounded refusal is success: only the first route is tried.
    expect(primaryRequests.map((request) => request.model)).toEqual([
      "openai/gpt-5.4-nano:nitro"
    ]);
    expect(fallbackRequests).toEqual([]);
    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("primary");
  });
});
