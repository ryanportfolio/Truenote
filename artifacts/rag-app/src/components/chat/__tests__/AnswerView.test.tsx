import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerView } from "../AnswerView";
import type { AskResponse } from "@/types/api";

const result: AskResponse = {
  queryLogId: "query-1",
  sessionId: "session-1",
  answer: "The fee is **$25** [chunk-1].",
  sources: [
    {
      chunk_id: "chunk-1",
      doc_title: "Cancellation Policy",
      excerpt: "The fee is $25.",
      doc_id: null
    }
  ],
  refused: false,
  confidence: "high",
  retrievedChunks: [],
  latencyMs: 5897,
  topScore: 0.96,
  rewrittenQuestion: "What is the cancellation fee?"
};

describe("AnswerView", () => {
  it("does not render confidence, rerank score, or latency telemetry", () => {
    const html = renderToStaticMarkup(
      <AnswerView result={result} showDebug />
    );

    expect(html).not.toContain("Confidence:");
    expect(html).not.toContain("Top score:");
    expect(html).not.toContain("5897 ms");
    expect(html).not.toContain("Searched as:");
  });

  it("does not render latency on refusals", () => {
    const html = renderToStaticMarkup(
      <AnswerView
        result={{ ...result, refused: true, answer: "Not found", sources: [] }}
        showDebug
      />
    );

    expect(html).not.toContain("5897 ms");
  });
});
