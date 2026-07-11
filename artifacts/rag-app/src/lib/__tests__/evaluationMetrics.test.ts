import { describe, expect, it } from "vitest";
import {
  comparableToBaseline,
  compareMetric,
  evalPassRate
} from "../evaluationMetrics";
import type { EvalRunListItem } from "@/types/api";

describe("evaluation metrics", () => {
  it("computes pass rate without treating an empty run as perfect", () => {
    expect(
      evalPassRate({ totalQuestions: 4, passed: 3 } as Parameters<typeof evalPassRate>[0])
    ).toBe(75);
    expect(
      evalPassRate({ totalQuestions: 0, passed: 0 } as Parameters<typeof evalPassRate>[0])
    ).toBeNull();
  });

  it("assigns improvement direction for higher- and lower-is-better metrics", () => {
    expect(compareMetric(90, 80)).toEqual({ value: 10, tone: "better" });
    expect(compareMetric(7, 9, false)).toEqual({ value: -2, tone: "better" });
    expect(compareMetric(null, 80)).toBeNull();
  });

  it("shows baseline deltas only for the same persisted question set", () => {
    const run = {
      questionId: null,
      questionCount: 10,
      configuration: {
        judge: false,
        questionSetHash: "same",
        generation: { id: "route", label: "Route", model: "model", providerLabel: "Provider" },
        fallback: { label: "Backup", model: "backup", providerLabel: "Provider" },
        retrieval: { topK: 8, candidateK: 40, threshold: 0.3, neighborAnchors: 3, rerankModel: "rerank" }
      }
    } as EvalRunListItem;
    expect(comparableToBaseline(run, { ...run, id: "baseline" })).toBe(true);
    expect(
      comparableToBaseline(run, {
        ...run,
        id: "changed",
        configuration: { ...run.configuration!, questionSetHash: "changed" }
      })
    ).toBe(false);
  });
});
