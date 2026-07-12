/**
 * Bounded per-call deadlines and retry caps for every external provider call.
 *
 * Why this exists: the OpenAI and Cohere SDKs default to long timeouts (OpenAI
 * v4: 10 minutes) and silent retries. On the answer path a CSR is mid-call, so
 * an unbounded provider stall — or a hung primary generation route multiplied
 * across the fallback chain — can leave them waiting minutes, and a closed
 * browser tab keeps burning provider spend with nothing to receive the result.
 *
 * Every external call gets an explicit, env-tunable per-request timeout and a
 * bounded retry count; the /ask pipeline gets one overall deadline that fails
 * closed with the canned refusal rather than a partial answer. Values are read
 * once per process with safe fallbacks. All timeouts are milliseconds.
 */

export interface ProviderDeadline {
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Retries AFTER the first attempt (0 = single attempt, no retry). */
  maxRetries: number;
}

export interface DeadlineConfig {
  /** Live query-path question embedding. Tight — a CSR is waiting. */
  queryEmbedding: ProviderDeadline;
  /** Background ingestion embedding. Looser — batch job, retry blast radius bounded by batch size. */
  ingestionEmbedding: ProviderDeadline;
  /** Cohere rerank pass on the live path. */
  rerank: ProviderDeadline;
  /** One OpenRouter generation attempt. The chain may make several. */
  generation: ProviderDeadline;
  /** Follow-up query rewrite (fail-open, pre-retrieval). */
  rewrite: ProviderDeadline;
  /** Detached session auto-naming (runs after the answer ships). */
  nameSession: ProviderDeadline;
  /** Eval-only faithfulness judge. Not latency-sensitive, still bounded. */
  faithfulness: ProviderDeadline;
  /** Ingestion image description (vision). Background, still bounded. */
  imageDescribe: ProviderDeadline;
  /** Overall /ask wall-clock budget. Exceeded → fail closed with the canned refusal. */
  askDeadlineMs: number;
}

const TIMEOUT_MIN_MS = 100;
const TIMEOUT_MAX_MS = 600_000;
const RETRIES_MIN = 0;
const RETRIES_MAX = 5;
const ASK_DEADLINE_MIN_MS = 1_000;
const ASK_DEADLINE_MAX_MS = 300_000;

function readIntEnv(key: string, fallback: number, min: number, max: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[deadlines] ${key}=${JSON.stringify(raw)} is out of range ` +
        `[${min}, ${max}]; using default ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

function readDeadline(
  prefix: string,
  timeoutFallback: number,
  retriesFallback: number
): ProviderDeadline {
  return {
    timeoutMs: readIntEnv(`${prefix}_TIMEOUT_MS`, timeoutFallback, TIMEOUT_MIN_MS, TIMEOUT_MAX_MS),
    maxRetries: readIntEnv(`${prefix}_MAX_RETRIES`, retriesFallback, RETRIES_MIN, RETRIES_MAX)
  };
}

let cached: DeadlineConfig | null = null;

/** Effective deadline configuration, memoized at first read. */
export function getDeadlineConfig(): DeadlineConfig {
  if (cached !== null) return cached;
  cached = {
    queryEmbedding: readDeadline("EMBED_QUERY", 5_000, 1),
    ingestionEmbedding: readDeadline("EMBED_INGEST", 30_000, 2),
    rerank: readDeadline("RERANK", 5_000, 1),
    generation: readDeadline("GENERATION", 20_000, 1),
    rewrite: readDeadline("REWRITE", 5_000, 1),
    nameSession: readDeadline("NAME_SESSION", 5_000, 1),
    faithfulness: readDeadline("FAITHFULNESS", 60_000, 2),
    imageDescribe: readDeadline("IMAGE_DESCRIBE", 30_000, 2),
    askDeadlineMs: readIntEnv(
      "ASK_DEADLINE_MS",
      45_000,
      ASK_DEADLINE_MIN_MS,
      ASK_DEADLINE_MAX_MS
    )
  };
  return cached;
}

/** Test-only escape hatch — clears the memoized value. */
export function resetDeadlineConfigForTests(): void {
  cached = null;
}

/**
 * True when an error is an AbortSignal-triggered abort (client disconnect or
 * the overall /ask deadline), NOT an ordinary provider timeout or error. The
 * OpenAI SDK throws APIUserAbortError on signal abort; the Cohere SDK and the
 * platform throw a DOMException/Error named "AbortError". A provider's own
 * per-request timeout surfaces as APIConnectionTimeoutError (name differs), so
 * it is correctly NOT treated as an abort — that lets the generation chain
 * advance to the next route on a slow provider while still halting the whole
 * pipeline the instant the request is cancelled.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "APIUserAbortError";
}
