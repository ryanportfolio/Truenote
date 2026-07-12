import { describe, expect, it } from "vitest";
import { prepareErrorLog } from "../error-log.js";

describe("error log preparation", () => {
  it("preserves provider diagnostics while redacting credentials", () => {
    const error = Object.assign(new Error("Bearer live-token rejected sk-proj-secret123"), {
      status: 400,
      code: "unsupported_parameter",
      type: "invalid_request_error",
      param: "response_format",
      request_id: "req-mercury-123",
      headers: {
        authorization: "Bearer live-token",
        "x-request-id": "req-mercury-123"
      },
      error: {
        message: "response_format is unsupported",
        api_key: "sk-proj-secret123",
        database: "postgresql://admin:secret@db.example/app"
      }
    });

    const prepared = prepareErrorLog({
      severity: "warning",
      source: "generation",
      operation: "openrouter-route-attempt",
      error,
      provider: "inception",
      model: "inception/mercury-2",
      routeId: "mercury-2-inception",
      context: { token_count: 12, access_token: "secret-token" }
    });

    expect(prepared).toMatchObject({
      severity: "warning",
      status: 400,
      code: "unsupported_parameter",
      requestId: "req-mercury-123",
      provider: "inception",
      model: "inception/mercury-2"
    });
    const serialized = JSON.stringify(prepared);
    expect(serialized).toContain("response_format is unsupported");
    expect(serialized).toContain('"token_count":12');
    expect(serialized).not.toContain("live-token");
    expect(serialized).not.toContain("secret123");
    expect(serialized).not.toContain("admin:secret");
    expect(serialized).not.toContain("secret-token");
    expect(serialized).toContain("[REDACTED]");
  });

  it("serializes circular causes without throwing", () => {
    const cause: { message: string; self?: unknown } = { message: "network failed" };
    cause.self = cause;
    const error = Object.assign(new Error("outer failure"), { cause });
    const prepared = prepareErrorLog({
      source: "worker",
      operation: "worker-main",
      error
    });
    expect(JSON.stringify(prepared.details)).toContain("[circular]");
  });
});
