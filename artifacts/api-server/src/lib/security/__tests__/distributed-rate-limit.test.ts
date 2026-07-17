import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enforceAskRateLimit,
  enforceWorkloadRateLimit,
  workloadRateLimitSettings,
  type RateLimitExecutor
} from "../distributed-rate-limit.js";
import { SecurityControlsNotReadyError } from "../errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function executorWith(
  rows: Record<string, unknown>[]
): RateLimitExecutor {
  return { execute: vi.fn().mockResolvedValue({ rows }) };
}

describe("distributed rate limits", () => {
  it("uses bounded workload defaults and ignores invalid overrides", () => {
    expect(workloadRateLimitSettings("document_ingestion", {})).toEqual({
      limit: 60,
      windowSeconds: 3600
    });
    expect(
      workloadRateLimitSettings("evaluation_run", {
        EVAL_RUN_RATE_LIMIT_PER_USER: "7",
        WORKLOAD_RATE_LIMIT_WINDOW_SECONDS: "900"
      })
    ).toEqual({ limit: 7, windowSeconds: 900 });
    expect(
      workloadRateLimitSettings("bulk_user_import", {
        BULK_USER_IMPORT_RATE_LIMIT_PER_USER: "0",
        WORKLOAD_RATE_LIMIT_WINDOW_SECONDS: "invalid"
      })
    ).toEqual({ limit: 5, windowSeconds: 3600 });
    expect(workloadRateLimitSettings("credential_administration", {})).toEqual({
      limit: 60,
      windowSeconds: 3600
    });
    expect(workloadRateLimitSettings("password_change", {})).toEqual({
      limit: 10,
      windowSeconds: 3600
    });
  });

  it("returns workload denial details from the shared database counter", async () => {
    const executor = executorWith([
      { allowed: false, retry_after_seconds: 321 }
    ]);
    await expect(
      enforceWorkloadRateLimit(
        { operation: "document_ingestion", userId: "user-1" },
        executor
      )
    ).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 321,
      scope: "user",
      operation: "document_ingestion"
    });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it("stops after a denied ask user bucket", async () => {
    const executor = executorWith([
      { allowed: false, retry_after_seconds: 12 }
    ]);
    await expect(
      enforceAskRateLimit(
        { userId: "user-1", programId: "program-1" },
        executor
      )
    ).resolves.toEqual({
      allowed: false,
      retryAfterSeconds: 12,
      scope: "user"
    });
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it("translates a missing counter table into the security readiness error", async () => {
    const executor: RateLimitExecutor = {
      execute: vi.fn().mockRejectedValue({ code: "42P01" })
    };
    await expect(
      enforceWorkloadRateLimit(
        { operation: "evaluation_run", userId: "user-1" },
        executor
      )
    ).rejects.toBeInstanceOf(SecurityControlsNotReadyError);
  });
});
