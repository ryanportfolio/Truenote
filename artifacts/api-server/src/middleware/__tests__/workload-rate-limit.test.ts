import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { recordSecurityEventBestEffort } from "../../lib/security/audit.js";
import { workloadRateLimitMiddleware } from "../workload-rate-limit.js";

vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEventBestEffort: vi.fn()
}));

function request(authenticated = true): Request {
  return {
    user: authenticated
      ? {
          id: "user-1",
          email: "user@example.com",
          role: "manager",
          programId: "program-1",
          name: "User",
          mustResetPassword: false
        }
      : null,
    ip: "203.0.113.10",
    header: () => undefined
  } as unknown as Request;
}

function response(): {
  res: Response;
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
} {
  const state = {
    res: null as unknown as Response,
    statusCode: null as number | null,
    headers: {} as Record<string, string>,
    body: null as unknown
  };
  state.res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return state.res;
    },
    status(code: number) {
      state.statusCode = code;
      return state.res;
    },
    json(body: unknown) {
      state.body = body;
      return state.res;
    }
  } as unknown as Response;
  return state;
}

describe("workloadRateLimitMiddleware", () => {
  it("continues when the distributed counter allows the operation", async () => {
    const enforce = vi.fn().mockResolvedValue({
      allowed: true,
      retryAfterSeconds: 60,
      scope: "user",
      operation: "evaluation_run"
    });
    const next = vi.fn() as unknown as NextFunction;
    const state = response();

    await workloadRateLimitMiddleware("evaluation_run", enforce)(
      request(),
      state.res,
      next
    );

    expect(next).toHaveBeenCalledOnce();
    expect(state.statusCode).toBeNull();
  });

  it("returns an audited 429 with Retry-After when denied", async () => {
    const enforce = vi.fn().mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 321,
      scope: "user",
      operation: "bulk_user_import"
    });
    const next = vi.fn() as unknown as NextFunction;
    const state = response();

    await workloadRateLimitMiddleware("bulk_user_import", enforce)(
      request(),
      state.res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(429);
    expect(state.headers["Retry-After"]).toBe("321");
    expect(state.body).toEqual({
      error: "Too many bulk user imports. Wait and try again.",
      code: "workload_rate_limited"
    });
    expect(recordSecurityEventBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workload.rate_limited",
        resourceId: "bulk_user_import"
      })
    );
  });

  it("fails closed when mounted without an authenticated principal", async () => {
    const enforce = vi.fn();
    const next = vi.fn() as unknown as NextFunction;
    const state = response();

    await workloadRateLimitMiddleware("document_ingestion", enforce)(
      request(false),
      state.res,
      next
    );

    expect(enforce).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(401);
  });

  it("delegates counter failures to the centralized error handler", async () => {
    const failure = new Error("counter unavailable");
    const enforce = vi.fn().mockRejectedValue(failure);
    const next = vi.fn() as unknown as NextFunction;
    const state = response();

    await workloadRateLimitMiddleware("evaluation_run", enforce)(
      request(),
      state.res,
      next
    );

    expect(next).toHaveBeenCalledWith(failure);
    expect(state.statusCode).toBeNull();
  });
});
