export const PIPELINE_TIMING_VERSION = 1 as const;

export type PipelineStageGroup = "request" | "retrieval" | "finalization";

export interface PipelineStageDefinition {
  key: string;
  label: string;
  group: PipelineStageGroup;
}

/**
 * Stable presentation order for the observability API and dashboard. The
 * request group is intentionally non-overlapping. Retrieval contains the
 * detailed children of the request-level `retrieval` duration.
 */
export const PIPELINE_STAGE_DEFINITIONS: readonly PipelineStageDefinition[] = [
  { key: "programScope", label: "Program scope", group: "request" },
  { key: "sessionResolution", label: "Session resolution", group: "request" },
  { key: "programLookup", label: "Program lookup", group: "request" },
  { key: "rewrite", label: "Follow-up rewrite", group: "request" },
  { key: "retrieval", label: "Retrieval", group: "request" },
  { key: "generation", label: "Answer generation", group: "request" },
  { key: "finalization", label: "Response finalization", group: "request" },
  { key: "embedding", label: "Question embedding", group: "retrieval" },
  { key: "vectorSearch", label: "Vector search", group: "retrieval" },
  { key: "keywordSearch", label: "Keyword search", group: "retrieval" },
  { key: "trigramSearch", label: "Trigram fallback", group: "retrieval" },
  { key: "candidateMerge", label: "Candidate merge", group: "retrieval" },
  { key: "rerank", label: "Cohere rerank", group: "retrieval" },
  { key: "neighborFetch", label: "Neighbor fetch", group: "retrieval" },
  { key: "neighborMerge", label: "Neighbor merge", group: "retrieval" },
  { key: "responseAssembly", label: "Response assembly", group: "finalization" },
  { key: "queryLogWrite", label: "Query-log write", group: "finalization" },
  { key: "citationSnapshots", label: "Citation snapshots", group: "finalization" },
  { key: "sessionTouch", label: "Session update", group: "finalization" }
] as const;

export type ProviderAttemptOutcome = "success" | "invalid" | "error";

/**
 * Token usage for one provider attempt, when the provider reports it. Counts
 * only — no prices. Prices change and vary by contract, so cost-in-dollars is
 * computed by the operator from these counts, never hardcoded here. Absent when
 * the attempt failed before a usage block came back.
 */
export interface ProviderTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ProviderAttemptTiming {
  routeId: string;
  provider: string;
  model: string;
  durationMs: number;
  outcome: ProviderAttemptOutcome;
  /** Present when the provider returned a usage block for this attempt. */
  tokens?: ProviderTokenUsage;
}

export interface PipelineTimingCounts {
  vectorCandidates: number;
  keywordCandidates: number;
  mergedCandidates: number;
  rankedChunks: number;
  contextChunks: number;
}

export interface PipelineTimingContext {
  rewriteCalled: boolean;
  trigramFallback: boolean;
  generationPath: "retrieval-refusal" | "primary" | "fallback" | "fallback-failed";
  rerankModel: string;
}

export interface PipelineTimingBreakdown {
  version: typeof PIPELINE_TIMING_VERSION;
  totalMs: number;
  stages: Record<string, number>;
  counts: PipelineTimingCounts;
  context: PipelineTimingContext;
  providerAttempts: ProviderAttemptTiming[];
}

export interface PipelineStageStat extends PipelineStageDefinition {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ProviderTimingStat {
  routeId: string;
  provider: string;
  model: string;
  attempts: number;
  successes: number;
  successRatePct: number;
  p50Ms: number;
  p95Ms: number;
  /** How many of the attempts reported token usage. */
  tokenSamples: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  /** Mean total tokens per token-reporting attempt (0 when none reported). */
  meanTotalTokens: number;
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate a persisted token-usage block, keeping only finite non-negative counts. */
function normalizeTokenUsage(value: unknown): ProviderTokenUsage | null {
  const root = objectValue(value);
  if (!root) return null;
  const promptTokens = finiteNonNegative(root.promptTokens);
  const completionTokens = finiteNonNegative(root.completionTokens);
  const totalTokens = finiteNonNegative(root.totalTokens);
  const usage: ProviderTokenUsage = {};
  if (promptTokens !== null) usage.promptTokens = promptTokens;
  if (completionTokens !== null) usage.completionTokens = completionTokens;
  if (totalTokens !== null) usage.totalTokens = totalTokens;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** Validate persisted JSONB before exposing it through the operator API. */
export function normalizePipelineTiming(value: unknown): PipelineTimingBreakdown | null {
  const root = objectValue(value);
  if (!root || root.version !== PIPELINE_TIMING_VERSION) return null;
  const totalMs = finiteNonNegative(root.totalMs);
  const stagesValue = objectValue(root.stages);
  const countsValue = objectValue(root.counts);
  const contextValue = objectValue(root.context);
  if (totalMs === null || !stagesValue || !countsValue || !contextValue) return null;

  const stages: Record<string, number> = {};
  for (const definition of PIPELINE_STAGE_DEFINITIONS) {
    const duration = finiteNonNegative(stagesValue[definition.key]);
    if (duration !== null) stages[definition.key] = duration;
  }

  const count = (key: keyof PipelineTimingCounts): number | null =>
    finiteNonNegative(countsValue[key]);
  const vectorCandidates = count("vectorCandidates");
  const keywordCandidates = count("keywordCandidates");
  const mergedCandidates = count("mergedCandidates");
  const rankedChunks = count("rankedChunks");
  const contextChunks = count("contextChunks");
  if (
    vectorCandidates === null ||
    keywordCandidates === null ||
    mergedCandidates === null ||
    rankedChunks === null ||
    contextChunks === null
  ) {
    return null;
  }

  const generationPath = contextValue.generationPath;
  if (
    typeof contextValue.rewriteCalled !== "boolean" ||
    typeof contextValue.trigramFallback !== "boolean" ||
    typeof contextValue.rerankModel !== "string" ||
    (generationPath !== "retrieval-refusal" &&
      generationPath !== "primary" &&
      generationPath !== "fallback" &&
      generationPath !== "fallback-failed")
  ) {
    return null;
  }

  const providerAttempts: ProviderAttemptTiming[] = [];
  if (Array.isArray(root.providerAttempts)) {
    for (const rawAttempt of root.providerAttempts) {
      const attempt = objectValue(rawAttempt);
      if (!attempt) continue;
      const durationMs = finiteNonNegative(attempt.durationMs);
      const outcome = attempt.outcome;
      if (
        typeof attempt.routeId !== "string" ||
        typeof attempt.provider !== "string" ||
        typeof attempt.model !== "string" ||
        durationMs === null ||
        (outcome !== "success" && outcome !== "invalid" && outcome !== "error")
      ) {
        continue;
      }
      const tokens = normalizeTokenUsage(attempt.tokens);
      providerAttempts.push({
        routeId: attempt.routeId,
        provider: attempt.provider,
        model: attempt.model,
        durationMs,
        outcome,
        ...(tokens ? { tokens } : {})
      });
    }
  }

  return {
    version: PIPELINE_TIMING_VERSION,
    totalMs,
    stages,
    counts: {
      vectorCandidates,
      keywordCandidates,
      mergedCandidates,
      rankedChunks,
      contextChunks
    },
    context: {
      rewriteCalled: contextValue.rewriteCalled,
      trigramFallback: contextValue.trigramFallback,
      generationPath,
      rerankModel: contextValue.rerankModel
    },
    providerAttempts
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))] ?? 0;
}

export function summarizeStageTimings(
  timings: PipelineTimingBreakdown[]
): PipelineStageStat[] {
  return PIPELINE_STAGE_DEFINITIONS.flatMap((definition) => {
    const values = timings.flatMap((timing) => {
      const value = timing.stages[definition.key];
      return value === undefined ? [] : [value];
    });
    if (values.length === 0) return [];
    return [{
      ...definition,
      samples: values.length,
      meanMs: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      p50Ms: percentile(values, 50),
      p95Ms: percentile(values, 95)
    }];
  });
}

export function summarizeProviderTimings(
  timings: PipelineTimingBreakdown[]
): ProviderTimingStat[] {
  const grouped = new Map<string, ProviderAttemptTiming[]>();
  for (const timing of timings) {
    for (const attempt of timing.providerAttempts) {
      const key = `${attempt.routeId}\u0000${attempt.provider}\u0000${attempt.model}`;
      const attempts = grouped.get(key) ?? [];
      attempts.push(attempt);
      grouped.set(key, attempts);
    }
  }
  return Array.from(grouped.values())
    .map((attempts) => {
      const first = attempts[0];
      if (!first) return null;
      const durations = attempts.map((attempt) => attempt.durationMs);
      const successes = attempts.filter((attempt) => attempt.outcome === "success").length;
      let tokenSamples = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalTokens = 0;
      for (const attempt of attempts) {
        if (!attempt.tokens) continue;
        tokenSamples += 1;
        totalPromptTokens += attempt.tokens.promptTokens ?? 0;
        totalCompletionTokens += attempt.tokens.completionTokens ?? 0;
        totalTokens +=
          attempt.tokens.totalTokens ??
          (attempt.tokens.promptTokens ?? 0) + (attempt.tokens.completionTokens ?? 0);
      }
      return {
        routeId: first.routeId,
        provider: first.provider,
        model: first.model,
        attempts: attempts.length,
        successes,
        successRatePct: Math.round((successes / attempts.length) * 1000) / 10,
        p50Ms: percentile(durations, 50),
        p95Ms: percentile(durations, 95),
        tokenSamples,
        totalPromptTokens,
        totalCompletionTokens,
        totalTokens,
        meanTotalTokens: tokenSamples > 0 ? Math.round(totalTokens / tokenSamples) : 0
      } satisfies ProviderTimingStat;
    })
    .filter((value): value is ProviderTimingStat => value !== null)
    .sort((left, right) => right.attempts - left.attempts);
}

export function timingPercentile(
  timings: PipelineTimingBreakdown[],
  percentileValue: number
): number {
  return percentile(
    timings.map((timing) => timing.totalMs),
    percentileValue
  );
}
