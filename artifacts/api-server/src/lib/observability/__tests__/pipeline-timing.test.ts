import { describe, expect, it } from "vitest";
import {
  PIPELINE_TIMING_VERSION,
  normalizePipelineTiming,
  summarizeProviderTimings,
  summarizeStageTimings,
  timingPercentile,
  type PipelineTimingBreakdown
} from "../pipeline-timing.js";

function timing(
  totalMs: number,
  rerankMs: number,
  providerDurationMs = 0
): PipelineTimingBreakdown {
  return {
    version: PIPELINE_TIMING_VERSION,
    totalMs,
    stages: { retrieval: rerankMs + 10, rerank: rerankMs },
    counts: {
      vectorCandidates: 40,
      keywordCandidates: 20,
      mergedCandidates: 52,
      rankedChunks: 8,
      contextChunks: 12
    },
    context: {
      rewriteCalled: false,
      trigramFallback: false,
      generationPath: "primary",
      rerankModel: "rerank-english-v3.0"
    },
    providerAttempts: providerDurationMs > 0
      ? [{
          routeId: "route-a",
          provider: "provider-a",
          model: "model-a",
          durationMs: providerDurationMs,
          outcome: "success"
        }]
      : []
  };
}

describe("pipeline timing telemetry", () => {
  it("rejects malformed or unknown timing versions", () => {
    expect(normalizePipelineTiming(null)).toBeNull();
    expect(normalizePipelineTiming({ ...timing(100, 20), version: 2 })).toBeNull();
    expect(normalizePipelineTiming({ ...timing(100, 20), totalMs: -1 })).toBeNull();
  });

  it("normalizes known stages and ignores arbitrary persisted keys", () => {
    const normalized = normalizePipelineTiming({
      ...timing(100.4, 20.2),
      stages: { rerank: 20.2, secretStage: 999 }
    });
    expect(normalized?.totalMs).toBe(100);
    expect(normalized?.stages).toEqual({ rerank: 20 });
  });

  it("summarizes stage and total percentiles", () => {
    const timings = [timing(100, 10), timing(200, 20), timing(900, 80)];
    expect(timingPercentile(timings, 50)).toBe(200);
    expect(timingPercentile(timings, 95)).toBe(900);
    const rerank = summarizeStageTimings(timings).find((stage) => stage.key === "rerank");
    expect(rerank).toMatchObject({ samples: 3, meanMs: 37, p50Ms: 20, p95Ms: 80 });
  });

  it("aggregates provider success and latency without storing errors", () => {
    const first = timing(100, 10, 40);
    const second = timing(200, 20, 90);
    second.providerAttempts[0]!.outcome = "error";
    expect(summarizeProviderTimings([first, second])).toEqual([
      {
        routeId: "route-a",
        provider: "provider-a",
        model: "model-a",
        attempts: 2,
        successes: 1,
        successRatePct: 50,
        p50Ms: 40,
        p95Ms: 90
      }
    ]);
  });
});
