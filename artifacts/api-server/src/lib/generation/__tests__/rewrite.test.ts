import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { formatHistory, rewriteFollowUp } from "../rewrite.js";

/** The utility route returns the rewritten question as plain text. */
function stubClient(text: string | null): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({ choices: [{ message: { content: text } }] })
      }
    }
  } as unknown as OpenAI;
}

function throwingClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          throw new Error("model unavailable");
        }
      }
    }
  } as unknown as OpenAI;
}

/** Rejects as if the AbortSignal fired mid-request. */
function abortingClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => {
          const error = new Error("Request was aborted.");
          error.name = "APIUserAbortError";
          throw error;
        }
      }
    }
  } as unknown as OpenAI;
}

interface CapturedOptions {
  timeout?: number;
  maxRetries?: number;
  signal?: AbortSignal;
}

function optionsCapturingClient(options: CapturedOptions[]): OpenAI {
  return {
    chat: {
      completions: {
        create: async (_body: unknown, requestOptions: CapturedOptions) => {
          options.push(requestOptions);
          return { choices: [{ message: { content: "x" } }] };
        }
      }
    }
  } as unknown as OpenAI;
}

describe("rewriteFollowUp", () => {
  it("passes through on the first turn without calling the LLM", async () => {
    // No client injected: a call attempt would throw on missing API key,
    // so success here proves the passthrough short-circuits.
    const result = await rewriteFollowUp({ question: "What is the fee?", history: [] });
    expect(result).toEqual({ standaloneQuestion: "What is the fee?", llmCalled: false });
  });

  it("returns the rewritten standalone question for a follow-up", async () => {
    const result = await rewriteFollowUp(
      {
        question: "what about the premium plan?",
        history: [{ question: "cancellation fee for basic plan?", answer: "The fee is $25." }]
      },
      { client: stubClient("cancellation fee for the premium plan?") }
    );
    expect(result.standaloneQuestion).toBe("cancellation fee for the premium plan?");
    expect(result.llmCalled).toBe(true);
  });

  it("falls back to the original question when the model returns nothing", async () => {
    const result = await rewriteFollowUp(
      {
        question: "what about premium?",
        history: [{ question: "q", answer: "a" }]
      },
      { client: stubClient(null) }
    );
    expect(result.standaloneQuestion).toBe("what about premium?");
  });

  it("falls back to the original question when the model call throws", async () => {
    const result = await rewriteFollowUp(
      {
        question: "what about premium?",
        history: [{ question: "q", answer: "a" }]
      },
      { client: throwingClient() }
    );
    expect(result).toEqual({ standaloneQuestion: "what about premium?", llmCalled: false });
  });

  it("rethrows an abort instead of failing open to the raw question", async () => {
    // A cancelled request must halt the pipeline, not silently continue to
    // retrieval after the caller has already given up.
    await expect(
      rewriteFollowUp(
        {
          question: "what about premium?",
          history: [{ question: "q", answer: "a" }],
          signal: new AbortController().signal
        },
        { client: abortingClient() }
      )
    ).rejects.toThrow();
  });

  it("passes a bounded timeout, retry cap, and the abort signal to the model call", async () => {
    const options: CapturedOptions[] = [];
    const controller = new AbortController();

    await rewriteFollowUp(
      {
        question: "what about premium?",
        history: [{ question: "q", answer: "a" }],
        signal: controller.signal
      },
      { client: optionsCapturingClient(options) }
    );

    expect(options[0]?.timeout).toBeGreaterThan(0);
    expect(options[0]?.maxRetries).toBeGreaterThanOrEqual(0);
    expect(options[0]?.signal).toBe(controller.signal);
  });
});

describe("formatHistory", () => {
  it("keeps only the most recent turns and truncates long fields", () => {
    const long = "x".repeat(1000);
    const formatted = formatHistory([
      { question: "one", answer: "a1" },
      { question: "two", answer: "a2" },
      { question: "three", answer: long },
      { question: "four", answer: "a4" }
    ]);
    expect(formatted).not.toContain("one");
    expect(formatted).toContain("two");
    expect(formatted).toContain("four");
    // 500-char cap applied to the long answer.
    expect(formatted).toContain("x".repeat(500));
    expect(formatted).not.toContain("x".repeat(501));
  });
});
