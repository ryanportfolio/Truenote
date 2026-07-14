/**
 * Security-control DDL is intentionally applied outside the application by
 * the Replit Agent. This error lets routes distinguish "run the reviewed
 * setup DDL" from an ordinary database outage without exposing schema detail.
 */
export class SecurityControlsNotReadyError extends Error {
  constructor(
    message =
      "Security controls are not initialized. Ask an administrator to apply the P0/P1 security DDL."
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
