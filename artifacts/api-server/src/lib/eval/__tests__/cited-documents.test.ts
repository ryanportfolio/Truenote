import { describe, expect, it } from "vitest";
import {
  citedDocumentIds,
  evalQuestionSetHash,
  inlineCitedChunkIds,
  percentile,
  type EvalQuestionResult
} from "../runner.js";

describe("citedDocumentIds", () => {
  it("uses retrieved chunk identity, ignores uncited rows, and deduplicates docs", () => {
    expect(
      citedDocumentIds(
        ["chunk-a", "chunk-b", "missing"],
        [
          { id: "chunk-a", documentId: "doc-1" },
          { id: "chunk-b", documentId: "doc-1" },
          { id: "chunk-c", documentId: "doc-2" },
          { id: "missing", documentId: null }
        ]
      )
    ).toEqual(["doc-1"]);
  });
});

describe("evalQuestionSetHash", () => {
  const result = {
    questionId: "question-1",
    question: "What is the fee?",
    programId: "program-1",
    kind: "in-kb",
    expectedDocId: "document-1",
    expectedAnswerContains: ["$25"]
  } as EvalQuestionResult;

  it("changes when a scored definition changes, not when outcomes change", () => {
    const original = evalQuestionSetHash([result]);
    expect(evalQuestionSetHash([{ ...result, pass: false }])).toBe(original);
    expect(
      evalQuestionSetHash([{ ...result, expectedAnswerContains: ["$30"] }])
    ).not.toBe(original);
  });
});

describe("eval scoring helpers", () => {
  it("counts only sources actually cited inline", () => {
    expect(
      inlineCitedChunkIds("Answer [chunk-b].", [
        { chunk_id: "chunk-a" },
        { chunk_id: "chunk-b" }
      ])
    ).toEqual(["chunk-b"]);
  });

  it("uses nearest-rank percentiles without crossing integral boundaries", () => {
    expect(percentile([100, 200], 50)).toBe(100);
    expect(percentile(Array.from({ length: 20 }, (_, index) => index + 1), 95)).toBe(19);
  });
});
