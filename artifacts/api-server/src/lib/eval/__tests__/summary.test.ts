import { describe, expect, it } from "vitest";
import {
  summarizeEvalResults,
  type EvalQuestionResult
} from "../runner.js";

function result(
  overrides: Partial<EvalQuestionResult> = {}
): EvalQuestionResult {
  return {
    questionId: "question-1",
    question: "What is the fee?",
    programId: "program-1",
    programName: "Program",
    expectedDocId: "document-1",
    expectedAnswerContains: ["$25"],
    notes: null,
    answer: "The fee is $25.",
    refused: false,
    topScore: 0.9,
    citedChunkIds: ["chunk-1"],
    citedDocIds: ["document-1"],
    latencyMs: 100,
    generationPath: "primary",
    kind: "in-kb",
    pass: true,
    citationCorrect: true,
    phrasesPresent: [{ phrase: "$25", present: true }],
    answerCorrect: true,
    retrievalHit: true,
    rerankHit: true,
    expectedDocRank: 1,
    failureStage: null,
    faithfulnessPct: 100,
    unsupportedClaims: [],
    faithfulnessJudgeFailed: false,
    error: null,
    ...overrides
  };
}

describe("summarizeEvalResults", () => {
  it("keeps fallback and judge failures visible in the report", () => {
    const summary = summarizeEvalResults([
      result(),
      result({
        questionId: "question-2",
        generationPath: "fallback",
        faithfulnessPct: null,
        faithfulnessJudgeFailed: true
      }),
      result({
        questionId: "question-3",
        generationPath: "fallback-failed",
        refused: true,
        pass: false,
        citationCorrect: false,
        answerCorrect: false,
        faithfulnessPct: null
      })
    ]);

    expect(summary.fallbackGenerationCount).toBe(1);
    expect(summary.failedFallbackCount).toBe(1);
    expect(summary.judgeFailures).toBe(1);
    expect(summary.judgedQuestions).toBe(1);
  });
});
