import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDeadlineConfig,
  isAbortError,
  resetDeadlineConfigForTests
} from "../deadlines.js";

const KEYS = [
  "EMBED_QUERY_TIMEOUT_MS",
  "EMBED_QUERY_MAX_RETRIES",
  "GENERATION_TIMEOUT_MS",
  "GENERATION_MAX_RETRIES",
  "ASK_DEADLINE_MS"
];

describe("getDeadlineConfig", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
    resetDeadlineConfigForTests();
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetDeadlineConfigForTests();
  });

  it("uses safe defaults when the environment is unset", () => {
    const config = getDeadlineConfig();
    expect(config.queryEmbedding).toEqual({ timeoutMs: 5_000, maxRetries: 1 });
    expect(config.generation).toEqual({ timeoutMs: 20_000, maxRetries: 1 });
    expect(config.askDeadlineMs).toBe(45_000);
  });

  it("reads overrides from the environment", () => {
    process.env.EMBED_QUERY_TIMEOUT_MS = "8000";
    process.env.EMBED_QUERY_MAX_RETRIES = "3";
    process.env.ASK_DEADLINE_MS = "30000";
    resetDeadlineConfigForTests();
    const config = getDeadlineConfig();
    expect(config.queryEmbedding).toEqual({ timeoutMs: 8_000, maxRetries: 3 });
    expect(config.askDeadlineMs).toBe(30_000);
  });

  it("falls back when a value is out of range or unparseable", () => {
    process.env.EMBED_QUERY_TIMEOUT_MS = "50"; // below the 100ms floor
    process.env.EMBED_QUERY_MAX_RETRIES = "99"; // above the retry ceiling
    process.env.ASK_DEADLINE_MS = "not-a-number";
    resetDeadlineConfigForTests();
    const config = getDeadlineConfig();
    expect(config.queryEmbedding).toEqual({ timeoutMs: 5_000, maxRetries: 1 });
    expect(config.askDeadlineMs).toBe(45_000);
  });

  it("memoizes: a later env change is ignored until reset", () => {
    const first = getDeadlineConfig();
    process.env.ASK_DEADLINE_MS = "10000";
    expect(getDeadlineConfig().askDeadlineMs).toBe(first.askDeadlineMs);
    resetDeadlineConfigForTests();
    expect(getDeadlineConfig().askDeadlineMs).toBe(10_000);
  });
});

describe("isAbortError", () => {
  it("recognizes AbortSignal-triggered aborts", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(true);
    expect(isAbortError({ name: "APIUserAbortError" })).toBe(true);
    const domException = new DOMException("aborted", "AbortError");
    expect(isAbortError(domException)).toBe(true);
  });

  it("does NOT treat ordinary provider timeouts/errors as aborts", () => {
    // A provider's own per-request timeout must fall through to the next route.
    expect(isAbortError({ name: "APIConnectionTimeoutError" })).toBe(false);
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
