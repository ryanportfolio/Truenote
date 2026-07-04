import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { formatHistory, rewriteFollowUp } from "../rewrite.js";

function stubClient(parsed: { standalone_question: string } | null): OpenAI {
  return {
    beta: {
      chat: {
        completions: {
          parse: async () => ({ choices: [{ message: { parsed } }] })
        }
      }
    }
  } as unknown as OpenAI;
}

function throwingClient(): OpenAI {
  return {
    beta: {
      chat: {
        completions: {
          parse: async () => {
            throw new Error("model unavailable");
          }
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
      { client: stubClient({ standalone_question: "cancellation fee for the premium plan?" }) }
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
