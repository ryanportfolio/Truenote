import { describe, expect, it } from "vitest";
import {
  errorDiagnostic,
  serializeErrorBundle,
  serializeErrorDiagnostic
} from "../errorDiagnostics";
import type { ErrorLogItem } from "@/types/api";

function item(): ErrorLogItem {
  return {
    id: "error-1",
    occurredAt: "2026-07-11T12:00:00.000Z",
    severity: "warning",
    source: "generation",
    operation: "openrouter-route-attempt",
    message: "provider rejected response_format",
    name: "BadRequestError",
    stack: "BadRequestError: provider rejected response_format",
    code: "unsupported_parameter",
    status: 400,
    provider: "inception",
    model: "inception/mercury-2",
    routeId: "mercury-2-inception",
    requestId: "req-123",
    correlationId: "corr-123",
    method: null,
    path: null,
    userId: null,
    programId: "program-1",
    queryLogId: null,
    details: { providerResponse: { message: "unsupported" } }
  };
}

describe("error diagnostic handoff", () => {
  it("keeps the exact debugging fields and omits empty noise", () => {
    expect(errorDiagnostic(item())).toMatchObject({
      diagnostic_version: 1,
      provider: {
        name: "inception",
        model: "inception/mercury-2",
        route_id: "mercury-2-inception"
      },
      response: {
        http_status: 400,
        error_code: "unsupported_parameter",
        provider_request_id: "req-123"
      },
      error: { message: "provider rejected response_format" }
    });
    expect(serializeErrorDiagnostic(item())).not.toContain("query_log_id");
  });

  it("wraps all matching errors in one compact versioned bundle", () => {
    const serialized = serializeErrorBundle([item(), item()], {
      hours: 24,
      severity: "all",
      source: "generation"
    });
    expect(serialized).not.toContain("\n");
    expect(JSON.parse(serialized)).toMatchObject({
      diagnostic_bundle_version: 1,
      count: 2,
      filters: { hours: 24, severity: "all", source: "generation" }
    });
  });
});
