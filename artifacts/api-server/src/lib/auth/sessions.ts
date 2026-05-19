import { randomBytes, createHash } from "node:crypto";
import { eq, lt } from "drizzle-orm";
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
 */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
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
      expiresAt: sessions.expiresAt,
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
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  if (!row.isActive) return null;

  // Best-effort last-used-at touch. Failure here must not break the request,
  // so we swallow errors — the session is still valid even if the touch
  // doesn't land.
  void db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => {});

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
 * Delete every session for a user. Used after a password change so the
 * actor is forced to re-authenticate with the new credentials everywhere
 * (revoking any stolen cookies on the old password).
 */
export async function deleteAllSessionsForUser(userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
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

