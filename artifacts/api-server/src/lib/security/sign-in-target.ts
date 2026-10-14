import { createHash } from "node:crypto";
import type { Response } from "express";
import { z } from "zod";

/**
 * The email field of a password sign-in, as POST /api/auth/login validates
 * it (LoginBody in routes/auth.ts uses this schema).
 */
export const signInEmail = z.string().trim().email().max(254);

/**
 * The account a sign-in attempt targeted, added to the details of every
 * denied sign-in audit record (POAM-2026-032):
 *
 * - `targetUserId` when the account exists;
 * - otherwise `targetIdentifierSha256`, the SHA-256 hex digest of the
 *   submitted identifier trimmed and lowercased the way POST /api/auth/login
 *   normalizes an email, recorded only when the identifier is a valid email
 *   address (signInEmail);
 * - otherwise `targetIdentifierMalformed: true` when something else was
 *   submitted.
 *
 * Neither the raw identifier nor a digest of a non-email string is recorded:
 * people sometimes type a password into the email field, and an unsalted
 * digest of a password can be checked against guesses offline.
 */
export type SignInTarget =
  | { targetUserId: string }
  | { targetIdentifierSha256: string }
  | { targetIdentifierMalformed: true };

export function targetUser(userId: string): SignInTarget {
  return { targetUserId: userId };
}

/** Null when nothing usable was submitted (missing, not a string, blank). */
export function targetIdentifier(submitted: unknown): SignInTarget | null {
  if (typeof submitted !== "string" || !submitted.trim()) return null;
  const email = signInEmail.safeParse(submitted);
  if (!email.success) return { targetIdentifierMalformed: true };
  return {
    targetIdentifierSha256: createHash("sha256")
      .update(email.data.toLowerCase(), "utf8")
      .digest("hex")
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
