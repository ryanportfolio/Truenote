import { randomBytes, createHash } from "node:crypto";
import type { Response } from "express";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db-client.js";
import { sessions, users } from "@workspace/db/schema";
import type { UserRole } from "@workspace/db/schema";
import { getOidcConfig } from "./oidc.js";
import { isLocalLoginAllowed } from "./local-login-policy.js";
import { isIdleLimited, isPastIdleWindow } from "./session-policy.js";

/**
 * Cookie name used both server-side (read on every request) and surfaced
 * client-side as an httpOnly cookie. Stable string — changing it would log
 * everyone out.
 */
export const SESSION_COOKIE_NAME = "kbase_session";

/**
 * Session lifetime. Hard expiry, no sliding renewal. 7 days strikes a
 * balance between agent UX (rare re-logins during a workweek) and blast
 * radius if a cookie is stolen. Revocation is instant via DELETE on the
 * sessions row; long lifetimes are safe BECAUSE revocation works.
 */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `maxAgeMs` lets a caller whose session ends sooner than
 * SESSION_DURATION_MS (an SSO session, capped by SSO_SESSION_MAX_HOURS)
 * keep the cookie lifetime equal to the row's expires_at.
 */
export function setSessionCookie(
  res: Response,
  token: string,
  options: { maxAgeMs?: number } = {}
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: options.maxAgeMs ?? SESSION_DURATION_MS,
    path: "/"
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  programId: string | null;
  name: string;
  mustResetPassword: boolean;
}

/**
 * Generate a 256-bit random session token. URL-safe so it sits cleanly in a
 * cookie header without further encoding. Returned in plaintext to the
 * caller (who sets it as the cookie value); only the SHA-256 hash is
 * stored in the DB.
 *
 * Exported because the password-change flow needs to mint a token inside
 * its own transaction (revoke + reissue must be atomic), so it can't go
 * through createSession() which owns its own write.
 */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** `db`, or a transaction from `db.transaction`. */
export type SessionWriter = Pick<typeof db, "insert">;

/**
 * Create a new session row for the given user and return the plaintext
 * token. The caller is responsible for setting this as the session cookie
 * value. We never log or persist the plaintext token.
 *
 * Pass a transaction as `executor` to insert the row inside it; set the
 * cookie only after that transaction commits.
 */
export async function createSession(
  userId: string,
  executor: SessionWriter = db
): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await executor.insert(sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Look up a session by its cookie token. Returns the joined user payload
 * suitable for attaching to req.user, or null if the token is missing,
 * expired, points at an inactive user, or is a local (password) session
 * whose user the current LOCAL_LOGIN_MODE no longer allows.
 *
 * Expiry is filtered in SQL (not just in app code) so the index on
 * sessions(expires_at) actually helps, and expired rows don't waste
 * round-trip bandwidth on every authenticated request.
 *
 * Idle limit: an oidc session, or a local session while LOCAL_LOGIN_MODE
 * is not `enabled`, whose last_used_at is older than SESSION_IDLE_MINUTES
 * is deleted (best effort) and refused.
 *
 * Side effect: bumps last_used_at when a valid session is touched, unless
 * `options.background` is true (requests sent with
 * `X-Truenote-Background: 1`), so background polling never keeps an idle
 * session alive. This is a single UPDATE per authenticated request.
 */
export async function findSessionByToken(
  token: string | undefined,
  options: { background?: boolean } = {}
): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const rows = await db
    .select({
      sessionId: sessions.id,
      userId: users.id,
      email: users.email,
      role: users.role,
      programId: users.programId,
      name: users.name,
      isActive: users.isActive,
      mustResetPassword: users.mustResetPassword,
      authMethod: sessions.authMethod,
      lastUsedAt: sessions.lastUsedAt
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date()))
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (!row.isActive) return null;
  const localLoginMode = getOidcConfig().localLoginMode;
  // A password session lives only as long as LOCAL_LOGIN_MODE would still
  // let this user log in locally, so switching to break_glass or disabled
  // ends existing password sessions at once. OIDC sessions are not
  // governed by the local mode.
  if (
    row.authMethod !== "oidc" &&
    !isLocalLoginAllowed(localLoginMode, row.role)
  ) {
    return null;
  }

  if (
    isIdleLimited(row.authMethod, localLoginMode) &&
    isPastIdleWindow(row.lastUsedAt)
  ) {
    // Idle session: remove the row so the token cannot come back if the
    // idle setting is raised later. The refusal does not depend on the
    // delete landing.
    try {
      await db.delete(sessions).where(eq(sessions.id, row.sessionId));
    } catch (err: unknown) {
      console.warn(
        "[auth] idle session delete failed:",
        err instanceof Error ? err.message : err
      );
    }
    return null;
  }

  if (options.background === true) {
    return toSessionUser(row);
  }

  // Best-effort last-used-at touch. Failure must not break the request
  // (the session is still valid even if the touch doesn't land), but log
  // at warn so operators can detect DB connectivity degradation before
  // the main query path starts failing too.
  void db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch((err: unknown) => {
      console.warn(
        "[auth] last_used_at touch failed:",
        err instanceof Error ? err.message : err
      );
    });

  return toSessionUser(row);
}

function toSessionUser(row: {
  userId: string;
  email: string;
  role: UserRole;
  programId: string | null;
  name: string;
  mustResetPassword: boolean;
}): SessionUser {
  return {
    id: row.userId,
    email: row.email,
    role: row.role,
    programId: row.programId ?? null,
    name: row.name,
    mustResetPassword: row.mustResetPassword
  };
}

/**
 * Delete a single session (logout). Idempotent — missing token or already-
 * deleted session both no-op.
 */
export async function deleteSessionByToken(
  token: string | undefined
): Promise<void> {
  if (!token) return;
  const tokenHash = hashToken(token);
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Hygiene: remove expired session rows. Cheap to call periodically; the
 * `expires_at` index keeps it bounded.
 */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return result.length;
}

