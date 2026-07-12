import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import {
  REFUSAL_TEXT,
  formatExcerpts,
  generateAnswer,
  validateGeneratedAnswer
} from "../answer.js";
import { APPROVED_MODEL_ROUTES, DEFAULT_MODEL_ROUTE } from "../model-routing.js";
import { getDeadlineConfig } from "../../deadlines.js";

const NANO_ROUTE = APPROVED_MODEL_ROUTES.find(
  (route) => route.id === "gpt-5.4-nano-azure-nitro"
)!;
const MERCURY_ROUTE = APPROVED_MODEL_ROUTES.find(
  (route) => route.id === "mercury-2-inception"
)!;
const GRANITE_ROUTE = APPROVED_MODEL_ROUTES.find(
  (route) => route.id === "granite-4.1-8b-wandb"
)!;

interface CapturedRequest {
  model: string;
  provider?: unknown;
  reasoning_effort?: string;
  temperature?: number;
  response_format?: unknown;
}

function stubClient(text: string | null, requests: CapturedRequest[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: CapturedRequest) => {
          requests.push(request);
          return { choices: [{ message: { content: text } }] };
        }
      }
    }
  } as unknown as OpenAI;
}

function routingClient(
  behaviors: Record<string, string | "throw" | null>,
  requests: CapturedRequest[]
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: CapturedRequest) => {
          requests.push(request);
          const behavior = behaviors[request.model];
          if (behavior === "throw") throw new Error("model unavailable");
          return { choices: [{ message: { content: behavior ?? null } }] };
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

const answer = "The cancellation fee is **$25** [chunk-1].";

describe("validateGeneratedAnswer", () => {
  it("gives models short source aliases instead of UUIDs", () => {
    expect(formatExcerpts(chunks)).toContain("SOURCE [S1]");
    expect(formatExcerpts(chunks)).not.toContain("SOURCE [chunk-1]");
  });

  it("maps a short source alias back to the retrieved chunk id", () => {
    const result = validateGeneratedAnswer("The fee is $25 [S1].", chunks);

    expect(result.failure).toBeNull();
    expect(result.payload?.answer).toBe("The fee is $25 [chunk-1].");
    expect(result.payload?.sources[0]?.chunk_id).toBe("chunk-1");
  });

  it("rejects an out-of-range source alias", () => {
    const result = validateGeneratedAnswer("The fee is $25 [S99].", chunks);

    expect(result.failure?.reason).toBe("unknown_citation_ids");
    expect(result.failure?.unknownCitationIds).toEqual(["S99"]);
  });

  it("builds source metadata from retrieved chunks and inline citations", () => {
    const result = validateGeneratedAnswer(answer, chunks);

    expect(result.failure).toBeNull();
    expect(result.payload).toEqual({
      answer,
      sources: [
        {
          chunk_id: "chunk-1",
          doc_title: "Cancellation Policy",
          excerpt: "The cancellation fee is $25."
        }
      ],
      refused: false,
      confidence: "medium"
    });
  });

  it("reports the exact missing-citation validation reason", () => {
    const returnedText = "The cancellation fee is **$25**.";

    expect(validateGeneratedAnswer(returnedText, chunks)).toEqual({
      payload: null,
      failure: {
        reason: "missing_inline_citation",
        inlineCitationIds: [],
        recognizedCitationIds: [],
        unknownCitationIds: [],
        availableChunkIds: ["chunk-1"],
        returnedText
      }
    });
  });

  it("reports every recognized and unknown inline citation id", () => {
    const returnedText =
      "The fee is $25 [chunk-1], effective now [chunk_id:invented-chunk].";

    expect(validateGeneratedAnswer(returnedText, chunks).failure).toEqual({
      reason: "unknown_citation_ids",
      inlineCitationIds: ["chunk-1", "invented-chunk"],
      recognizedCitationIds: ["chunk-1"],
      unknownCitationIds: ["invented-chunk"],
      availableChunkIds: ["chunk-1"],
      returnedText
    });
  });

  it("canonicalizes a copied chunk_id label around a recognized id", () => {
    const result = validateGeneratedAnswer(
      "Refunds arrive in 5-7 days [chunk_id:chunk-1].",
      chunks
    );

    expect(result.failure).toBeNull();
    expect(result.payload?.answer).toBe("Refunds arrive in 5-7 days [chunk-1].");
    expect(result.payload?.sources[0]?.chunk_id).toBe("chunk-1");
  });

  it("canonicalizes fullwidth citation brackets around a recognized id", () => {
    const result = validateGeneratedAnswer(
      "Refunds arrive in 5-7 days【chunk-1】.",
      chunks
    );

    expect(result.failure).toBeNull();
    expect(result.payload?.answer).toBe("Refunds arrive in 5-7 days[chunk-1].");
    expect(result.payload?.sources[0]?.chunk_id).toBe("chunk-1");
  });

  it("reports an empty answer before citation problems", () => {
    const result = validateGeneratedAnswer("  ", chunks);

    expect(result.failure?.reason).toBe("empty_answer");
    expect(result.failure?.returnedText).toBe("  ");
  });

  it("accepts the exact refusal text without citations", () => {
    expect(validateGeneratedAnswer(`  ${REFUSAL_TEXT}  `, chunks).payload).toEqual(
      expect.objectContaining({ refused: true, sources: [] })
    );
  });
});

describe("generateAnswer ZDR route fallback", () => {
  it("uses plain text on the default ZDR-only OpenRouter route", async () => {
    const requests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      { client: stubClient(answer, requests), routeChain: [DEFAULT_MODEL_ROUTE] }
    );

    expect(requests).toEqual([
      expect.objectContaining({
        model: "nvidia/nemotron-3-super-120b-a12b:nitro",
        reasoning_effort: "medium",
        provider: {
          only: ["digitalocean"],
          zdr: true,
          data_collection: "deny",
          allow_fallbacks: false
        }
      })
    ]);
    expect(requests[0]?.response_format).toBeUndefined();
    expect(result.payload.refused).toBe(false);
    expect(result.generationPath).toBe("primary");
  });

  it("routes Mercury 2 through Inception with ZDR and low reasoning", async () => {
    const requests: CapturedRequest[] = [];

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      { client: stubClient(answer, requests), routeChain: [MERCURY_ROUTE] }
    );

    expect(requests[0]).toEqual(
      expect.objectContaining({
        model: "inception/mercury-2",
        reasoning_effort: "low",
        provider: expect.objectContaining({ only: ["inception"], zdr: true })
      })
    );
  });

  it("routes Granite 4.1 8B only to its live WandB ZDR endpoint", async () => {
    const requests: CapturedRequest[] = [];

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      { client: stubClient(answer, requests), routeChain: [GRANITE_ROUTE] }
    );

    expect(requests[0]).toEqual(
      expect.objectContaining({
        model: "ibm-granite/granite-4.1-8b",
        temperature: 0,
        provider: expect.objectContaining({ only: ["wandb"], zdr: true })
      })
    );
    expect(requests[0]?.reasoning_effort).toBeUndefined();
  });

  it("cascades to the next ZDR route when a request throws", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": "throw", "inception/mercury-2": answer },
          requests
        ),
        routeChain: [NANO_ROUTE, MERCURY_ROUTE]
      }
    );

    expect(requests.map((request) => request.model)).toEqual([
      "openai/gpt-5.4-nano:nitro",
      "inception/mercury-2"
    ]);
    expect(result.generationPath).toBe("fallback");
    expect(result.providerAttempts).toHaveLength(2);
    warning.mockRestore();
  });

  it("cascades when a route returns no text", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": null, "inception/mercury-2": answer },
          []
        ),
        routeChain: [NANO_ROUTE, MERCURY_ROUTE]
      }
    );

    expect(result.generationPath).toBe("fallback");
    warning.mockRestore();
  });

  it("cascades when a route cites an unknown chunk", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          {
            "openai/gpt-5.4-nano:nitro": "The fee is $25 [unknown].",
            "inception/mercury-2": answer
          },
          []
        ),
        routeChain: [NANO_ROUTE, MERCURY_ROUTE]
      }
    );

    expect(result.generationPath).toBe("fallback");
    warning.mockRestore();
  });

  it("keeps a valid refusal without cascading", async () => {
    const requests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": REFUSAL_TEXT, "inception/mercury-2": answer },
          requests
        ),
        routeChain: [NANO_ROUTE, MERCURY_ROUTE]
      }
    );

    expect(requests).toHaveLength(1);
    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("primary");
  });

  it("returns a safe refusal without any direct-provider escape hatch", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: CapturedRequest[] = [];

    const result = await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      {
        client: routingClient(
          { "openai/gpt-5.4-nano:nitro": "throw", "inception/mercury-2": "throw" },
          requests
        ),
        routeChain: [NANO_ROUTE, MERCURY_ROUTE]
      }
    );

    expect(requests).toHaveLength(2);
    expect(result.providerAttempts.every((attempt) => attempt.provider !== "openai-direct"))
      .toBe(true);
    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("fallback-failed");
    warning.mockRestore();
  });
});

interface CapturedOptions {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

function optionsCapturingClient(text: string | null, options: CapturedOptions[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (_request: unknown, requestOptions: CapturedOptions) => {
          options.push(requestOptions);
          return { choices: [{ message: { content: text } }] };
        }
      }
    }
  } as unknown as OpenAI;
}

/** A client that rejects as if the AbortSignal fired mid-request. */
function abortingClient(requests: CapturedRequest[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: CapturedRequest) => {
          requests.push(request);
          const error = new Error("Request was aborted.");
          error.name = "APIUserAbortError";
          throw error;
        }
      }
    }
  } as unknown as OpenAI;
}

describe("generateAnswer cancellation + bounds", () => {
  it("passes a bounded per-request timeout and retry cap to every route call", async () => {
    const options: CapturedOptions[] = [];

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks },
      { client: optionsCapturingClient(answer, options), routeChain: [DEFAULT_MODEL_ROUTE] }
    );

    const generationDeadline = getDeadlineConfig().generation;
    expect(options[0]?.timeout).toBe(generationDeadline.timeoutMs);
    expect(options[0]?.maxRetries).toBe(generationDeadline.maxRetries);
    expect(options[0]?.timeout).toBeGreaterThan(0);
  });

  it("forwards the abort signal to the provider call", async () => {
    const options: CapturedOptions[] = [];
    const controller = new AbortController();

    await generateAnswer(
      { programName: "Test", question: "What is the fee?", chunks, signal: controller.signal },
      { client: optionsCapturingClient(answer, options), routeChain: [DEFAULT_MODEL_ROUTE] }
    );

    expect(options[0]?.signal).toBe(controller.signal);
  });

  it("halts the whole chain on abort instead of cascading to the next route", async () => {
    const requests: CapturedRequest[] = [];
    const controller = new AbortController();

    await expect(
      generateAnswer(
        {
          programName: "Test",
          question: "What is the fee?",
          chunks,
          signal: controller.signal
        },
        { client: abortingClient(requests), routeChain: [NANO_ROUTE, MERCURY_ROUTE] }
      )
    ).rejects.toThrow();

    // The abort stops the walk after the first attempt — no fallback spend.
    expect(requests).toHaveLength(1);
  });

  it("does not call any route when the signal is already aborted", async () => {
    const requests: CapturedRequest[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await generateAnswer(
      {
        programName: "Test",
        question: "What is the fee?",
        chunks,
        signal: controller.signal
      },
      { client: stubClient(answer, requests), routeChain: [NANO_ROUTE, MERCURY_ROUTE] }
    );

    expect(requests).toHaveLength(0);
    expect(result.payload.refused).toBe(true);
    expect(result.generationPath).toBe("fallback-failed");
  });
});
