import type { ErrorLogItem, ErrorLogSeverity } from "@/types/api";

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined)
  ) as Partial<T>;
}

/** Stable, compact handoff format optimized for pasting into a debugging task. */
export function errorDiagnostic(item: ErrorLogItem): Record<string, unknown> {
  return compact({
    diagnostic_version: 1,
    occurred_at: item.occurredAt,
    severity: item.severity,
    source: item.source,
    operation: item.operation,
    provider: Object.keys(compact({
      name: item.provider,
      model: item.model,
      route_id: item.routeId
    })).length > 0
      ? compact({ name: item.provider, model: item.model, route_id: item.routeId })
      : undefined,
    response: Object.keys(compact({
      http_status: item.status,
      error_code: item.code,
      provider_request_id: item.requestId
    })).length > 0
      ? compact({
          http_status: item.status,
          error_code: item.code,
          provider_request_id: item.requestId
        })
      : undefined,
    correlation_id: item.correlationId,
    request: Object.keys(compact({ method: item.method, path: item.path })).length > 0
      ? compact({ method: item.method, path: item.path })
      : undefined,
    scope: Object.keys(compact({
      user_id: item.userId,
      program_id: item.programId,
      query_log_id: item.queryLogId
    })).length > 0
      ? compact({
          user_id: item.userId,
          program_id: item.programId,
          query_log_id: item.queryLogId
        })
      : undefined,
    error: compact({
      name: item.name,
      message: item.message,
      stack: item.stack,
      details: item.details
    })
  });
}

export function serializeErrorDiagnostic(item: ErrorLogItem): string {
  return JSON.stringify(errorDiagnostic(item));
}

export function serializeErrorBundle(
  items: ErrorLogItem[],
  filters: {
    hours: number;
    severity: ErrorLogSeverity | "all";
    source?: string;
  }
): string {
  return JSON.stringify({
    diagnostic_bundle_version: 1,
    filters: compact(filters),
    count: items.length,
    errors: items.map(errorDiagnostic)
  });
}
