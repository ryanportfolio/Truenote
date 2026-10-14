import { createHash } from "node:crypto";
import type { Response } from "express";

/**
 * The account a sign-in attempt targeted, added to the details of every
 * denied sign-in audit record (POAM-2026-032): `targetUserId` when the
 * account exists, otherwise `targetIdentifierSha256`, the SHA-256 hex digest
 * of the submitted identifier trimmed and lowercased the way POST
 * /api/auth/login normalizes an email. The raw identifier is never recorded:
 * people sometimes type a password into the email field.
 */
export type SignInTarget =
  | { targetUserId: string }
  | { targetIdentifierSha256: string };

export function targetUser(userId: string): SignInTarget {
  return { targetUserId: userId };
}

/** Null when nothing usable was submitted (missing, not a string, blank). */
export function targetIdentifier(submitted: unknown): SignInTarget | null {
  if (typeof submitted !== "string") return null;
  const normalized = submitted.trim().toLowerCase();
  if (!normalized) return null;
  return {
    targetIdentifierSha256: createHash("sha256").update(normalized, "utf8").digest("hex")
  };
}

/** The submitted `email` field of a sign-in request body. */
export function submittedIdentifier(body: unknown): SignInTarget | null {
  return targetIdentifier(
    body && typeof body === "object" ? (body as { email?: unknown }).email : undefined
  );
}

// Keyed by the response object, so it lives exactly as long as the request.
const targets = new WeakMap<Response, SignInTarget>();

/**
 * Remember the target for this request's http.security_mutation record
 * (securityAuditMiddleware). A later call replaces an earlier one, so a
 * route notes the submitted identifier first and the user id once the
 * account is found.
 */
export function noteSignInTarget(res: Response, target: SignInTarget | null): void {
  if (target) targets.set(res, target);
}

/** The noted target, or an empty object to spread into event details. */
export function signInTargetOf(res: Response): SignInTarget | Record<string, never> {
  return targets.get(res) ?? {};
}
