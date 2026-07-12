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
    isProtected: false,
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

  it("reports held-out (protected) and tunable (open) pass rates separately", () => {
    const summary = summarizeEvalResults([
      result({ questionId: "p1", isProtected: true, pass: true }),
      result({ questionId: "p2", isProtected: true, pass: false }),
      result({ questionId: "o1", isProtected: false, pass: true }),
      result({ questionId: "o2", isProtected: false, pass: true }),
      result({ questionId: "o3", isProtected: false, pass: false })
    ]);

    expect(summary.splits).toEqual({
      protected: { total: 2, passed: 1, passRatePct: 50 },
      open: { total: 3, passed: 2, passRatePct: (2 / 3) * 100 }
    });
  });

  it("nulls a split's pass rate when it has no questions", () => {
    const summary = summarizeEvalResults([
      result({ questionId: "o1", isProtected: false, pass: true })
    ]);

    expect(summary.splits?.protected).toEqual({ total: 0, passed: 0, passRatePct: null });
    expect(summary.splits?.open).toEqual({ total: 1, passed: 1, passRatePct: 100 });
  });
});
