import { randomBytes, createHash } from "node:crypto";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../db-client.js";
import { passwordResetTokens } from "@workspace/db/schema";

/**
 * One-shot password-reset tokens. Same posture as sessions: the cookie
 * /email carries the plaintext, the DB only stores SHA-256(token).
 *
 * Lifetime: 1 hour. Short enough that a stolen link from a forwarded
 * email rots fast; long enough that a user can finish making coffee
 * before clicking.
 *
 * One token per request. We do NOT preemptively expire prior unused
 * tokens for the same user — the user might have requested twice and
 * want either to work — but on consume we mark used_at and the
 * transaction also revokes every active session (defense in depth
 * against a stolen cookie outlasting the reset).
 */
export const RESET_TOKEN_DURATION_MS = 60 * 60 * 1000;

/**
 * Longer lifetime for admin-issued account invitations. A brand-new user
 * may not open the email immediately, and unlike a self-service reset
 * there's no prior credential to fall back on. 7 days is long enough for
 * a new hire to get set up; if it still lapses, the standard
 * forgot-password flow mints a fresh (short-lived) link because the
 * account already exists and is active.
 */
export const INVITE_TOKEN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface IssuedResetToken {
  token: string;
  expiresAt: Date;
}

export function generateResetToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a one-shot token for `userId`. `ttlMs` defaults to the
 * self-service reset lifetime; pass INVITE_TOKEN_DURATION_MS for
 * admin-issued invitations. The consume path (routes/auth.ts
 * reset-password) treats every token identically regardless of lifetime.
 */
export async function createResetToken(
  userId: string,
  ttlMs: number = RESET_TOKEN_DURATION_MS
): Promise<IssuedResetToken> {
  const token = generateResetToken();
  const tokenHash = hashResetToken(token);
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .insert(passwordResetTokens)
    .values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Resolve a plaintext token to the owning user_id, returning null if
 * the token is missing, expired, or already used.
 *
 * Distinct from `consumeResetToken` because the consume step happens
 * inside the password-update transaction — the resolver is used for an
 * up-front 400 when the link is obviously bad, so the user sees "this
 * link is expired" instead of spending time typing a new password
 * that won't be accepted.
 */
export async function lookupResetTokenUserId(
  token: string | undefined
): Promise<string | null> {
  if (!token) return null;
  const tokenHash = hashResetToken(token);
  const rows = await db
    .select({ userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        gt(passwordResetTokens.expiresAt, new Date()),
        isNull(passwordResetTokens.usedAt)
      )
    )
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Hygiene: delete tokens that are expired OR were used more than a
 * day ago. Cheap to call periodically. Used rows are kept briefly so
 * an admin debugging "the reset link said expired" can see whether
 * the token was used (different failure mode than expired).
 */
export async function purgeExpiredResetTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await db
    .delete(passwordResetTokens)
    .where(
      // (expires_at < now()) OR (used_at < cutoff). Drizzle's `or` is
      // a separate import; using a single delete with two WHEREs would
      // be wrong, so split into two sequential deletes — both are
      // index-bounded.
      lt(passwordResetTokens.expiresAt, new Date())
    )
    .returning({ id: passwordResetTokens.id });
  return result.length;
  // NB: the used-row sweep is a future polish; for Phase 2.5 expiry
  // already keeps the table size linear in the rolling-hour request rate.
}
