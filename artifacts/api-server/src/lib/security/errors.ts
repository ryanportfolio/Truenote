/**
 * Security-control DDL is intentionally applied outside the application by
 * an operator (lib/db/sql, .claude/reference/deployment.md). This error lets routes distinguish "run the reviewed
 * setup DDL" from an ordinary database outage without exposing schema detail.
 * The default message reaches any caller, so it names no tables, DDL or setup
 * step; the error name in the error log and the response code identify the cause.
 */
export class SecurityControlsNotReadyError extends Error {
  constructor(
    message = "This service is temporarily unavailable. Try again later or contact an administrator."
  ) {
    super(message);
    this.name = "SecurityControlsNotReadyError";
  }
}

export function isMissingSecuritySchema(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "42P01" || code === "42703" || code === "42883";
}

export function translateSecuritySchemaError(error: unknown): never {
  if (isMissingSecuritySchema(error)) {
    throw new SecurityControlsNotReadyError();
  }
  throw error;
}
