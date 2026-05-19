import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db } from "../db-client.js";
import { sessions, users } from "@workspace/db/schema";
import type { UserRole } from "@workspace/db/schema";

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

/**
 * Create a new session row for the given user and return the plaintext
 * token. The caller is responsible for setting this as the session cookie
 * value. We never log or persist the plaintext token.
 */
export async function createSession(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const token = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  await db.insert(sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Look up a session by its cookie token. Returns the joined user payload
 * suitable for attaching to req.user, or null if the token is missing,
 * expired, or points at an inactive user.
 *
 * Expiry is filtered in SQL (not just in app code) so the index on
 * sessions(expires_at) actually helps, and expired rows don't waste
 * round-trip bandwidth on every authenticated request.
 *
 * Side effect: bumps last_used_at when a valid session is touched. This is
 * a single UPDATE per authenticated request — cheap at call-center traffic
 * levels and useful for "stale session" cleanup queries later.
 */
export async function findSessionByToken(
  token: string | undefined
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
      mustResetPassword: users.mustResetPassword
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

