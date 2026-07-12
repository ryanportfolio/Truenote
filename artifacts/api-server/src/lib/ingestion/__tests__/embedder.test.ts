import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import { OpenAIEmbedder } from "../embedder.js";

interface CapturedCall {
  body: { model: string; input: string[] };
  options: { timeout?: number; maxRetries?: number; signal?: AbortSignal };
}

function capturingClient(calls: CapturedCall[]): OpenAI {
  return {
    embeddings: {
      create: async (body: CapturedCall["body"], options: CapturedCall["options"]) => {
        calls.push({ body, options });
        return {
          data: body.input.map((_, index) => ({ index, embedding: [index] }))
        };
      }
    }
  } as unknown as OpenAI;
}

describe("OpenAIEmbedder", () => {
  it("applies a bounded per-request timeout and retry cap by default", async () => {
    const calls: CapturedCall[] = [];
    const embedder = new OpenAIEmbedder({ client: capturingClient(calls) });

    await embedder.embed(["hello"]);

    expect(calls[0]?.options.timeout).toBeGreaterThan(0);
    expect(calls[0]?.options.timeout).toBeLessThanOrEqual(600_000);
    expect(calls[0]?.options.maxRetries).toBeGreaterThanOrEqual(0);
  });

  it("honors the caller's explicit timeout and retry bounds", async () => {
    const calls: CapturedCall[] = [];
    const embedder = new OpenAIEmbedder({
      client: capturingClient(calls),
      timeoutMs: 5_000,
      maxRetries: 1
    });

    await embedder.embed(["hello"]);

    expect(calls[0]?.options.timeout).toBe(5_000);
    expect(calls[0]?.options.maxRetries).toBe(1);
  });

  it("forwards the abort signal to the embeddings call", async () => {
    const calls: CapturedCall[] = [];
    const embedder = new OpenAIEmbedder({ client: capturingClient(calls) });
    const controller = new AbortController();

    await embedder.embed(["hello"], { signal: controller.signal });

    expect(calls[0]?.options.signal).toBe(controller.signal);
  });

  it("preserves input order across batches via the response index", async () => {
    const calls: CapturedCall[] = [];
    const embedder = new OpenAIEmbedder({
      client: capturingClient(calls),
      batchSize: 2
    });

    const result = await embedder.embed(["a", "b", "c"]);

    // Two batches of size 2 and 1; each returns index-keyed embeddings.
    expect(calls).toHaveLength(2);
    expect(result).toEqual([[0], [1], [0]]);
  });
});
