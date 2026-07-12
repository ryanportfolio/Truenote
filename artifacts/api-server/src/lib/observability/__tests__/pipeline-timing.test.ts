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
        p95Ms: 90,
        tokenSamples: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        meanTotalTokens: 0
      }
    ]);
  });

  it("round-trips provider token usage through normalization", () => {
    const withTokens = timing(100, 10, 40);
    withTokens.providerAttempts[0]!.tokens = {
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500
    };
    const normalized = normalizePipelineTiming(withTokens);
    expect(normalized?.providerAttempts[0]?.tokens).toEqual({
      promptTokens: 1200,
      completionTokens: 300,
      totalTokens: 1500
    });
  });

  it("drops a token block with no finite non-negative counts", () => {
    const bad = timing(100, 10, 40);
    (bad.providerAttempts[0] as { tokens?: unknown }).tokens = {
      promptTokens: -5,
      completionTokens: "lots"
    };
    const normalized = normalizePipelineTiming(bad);
    expect(normalized?.providerAttempts[0]?.tokens).toBeUndefined();
  });

  it("sums and averages token usage across attempts, ignoring untokened ones", () => {
    const first = timing(100, 10, 40);
    first.providerAttempts[0]!.tokens = {
      promptTokens: 1000,
      completionTokens: 200,
      totalTokens: 1200
    };
    const second = timing(200, 20, 90); // no tokens reported
    const third = timing(150, 15, 50);
    third.providerAttempts[0]!.tokens = {
      promptTokens: 800,
      completionTokens: 200,
      totalTokens: 1000
    };
    const [stat] = summarizeProviderTimings([first, second, third]);
    expect(stat).toMatchObject({
      attempts: 3,
      tokenSamples: 2,
      totalPromptTokens: 1800,
      totalCompletionTokens: 400,
      totalTokens: 2200,
      meanTotalTokens: 1100
    });
  });

  it("derives totalTokens from prompt+completion when the provider omits it", () => {
    const only = timing(100, 10, 40);
    only.providerAttempts[0]!.tokens = { promptTokens: 700, completionTokens: 300 };
    const [stat] = summarizeProviderTimings([only]);
    expect(stat?.totalTokens).toBe(1000);
    expect(stat?.meanTotalTokens).toBe(1000);
  });
});
