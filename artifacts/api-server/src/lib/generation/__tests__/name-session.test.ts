import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { fallbackTitle, nameSession, MAX_TITLE_CHARS } from "../name-session.js";

/** The utility route returns text; the namer parses a JSON object from it. */
function stubClient(parsed: { title: string } | null): OpenAI {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: parsed ? JSON.stringify(parsed) : null } }]
        })
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

describe("fallbackTitle", () => {
  it("returns short questions unchanged, collapsing whitespace", () => {
    expect(fallbackTitle("  What is  the  fee? ")).toBe("What is the fee?");
  });

  it("truncates over-long questions to the title cap with an ellipsis", () => {
    const title = fallbackTitle("x".repeat(200));
    expect(title.length).toBe(MAX_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("nameSession", () => {
  it("uses the model title when present", async () => {
    const title = await nameSession(
      { question: "What is the cancellation fee on the Basic plan?" },
      { client: stubClient({ title: "Basic Plan Cancellation Fee" }) }
    );
    expect(title).toBe("Basic Plan Cancellation Fee");
  });

  it("falls back to the question when the model returns nothing", async () => {
    const title = await nameSession(
      { question: "How do I issue a refund?" },
      { client: stubClient(null) }
    );
    expect(title).toBe("How do I issue a refund?");
  });

  it("rejects an over-long model title in favor of the fallback", async () => {
    const title = await nameSession(
      { question: "Short question" },
      { client: stubClient({ title: "A ".repeat(80) }) }
    );
    expect(title).toBe("Short question");
  });

  it("falls back to the question when the model call throws", async () => {
    const title = await nameSession(
      { question: "What ID verifies a caller?" },
      { client: throwingClient() }
    );
    expect(title).toBe("What ID verifies a caller?");
  });

  it("never returns an empty title for a blank question", async () => {
    const title = await nameSession({ question: "   " }, { client: stubClient(null) });
    expect(title).toBe("New conversation");
  });
});
