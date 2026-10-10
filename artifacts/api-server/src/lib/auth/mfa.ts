import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import { eq, sql, type SQL } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  type Uint8Array_
} from "@simplewebauthn/server";
import { users, type UserRole } from "@workspace/db/schema";
import { db } from "../db-client.js";
import { recordAppError } from "../observability/error-log.js";
import { recordSecurityEventBestEffort } from "../security/audit.js";
import { recordAuthSuccess } from "./lockout.js";
import type { LocalLoginMode } from "./oidc.js";
import { createSession, setSessionCookie } from "./sessions.js";
import { getWebAuthnConfig } from "./webauthn-config.js";

/**
 * Second factor for local password login (lib/db/sql/0017_break_glass_mfa.sql).
 *
 * After the password verifies, a user with at least one passkey gets no
 * session. POST /api/auth/login creates a `login` row in mfa_challenges
 * (5 minutes) and sets an httpOnly cookie holding a random token; only the
 * token's SHA-256 is stored. routes/mfa.ts finds the challenge by that hash
 * and issues the session once a passkey assertion or a recovery code
 * verifies. When WebAuthn is not usably configured the challenge offers
 * recovery codes only, so a configuration mistake cannot lock the emergency
 * account out.
 */

export const MFA_COOKIE_NAME = "truenote_mfa";
export const MFA_COOKIE_PATH = "/api/auth/mfa";
export const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MFA_METHODS = ["passkey", "recovery_code"] as const;
export type MfaFactor = (typeof MFA_METHODS)[number];

export type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

export interface StoredPasskey {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array_;
  signCount: number;
  transports: string[];
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface MfaChallenge {
  id: string;
  userId: string;
  challenge: string;
}

export interface LoginMfaResponse {
  mfaRequired: true;
  methods: MfaFactor[];
  /** Absent when WebAuthn is not usably configured; methods is then ["recovery_code"]. */
  passkeyOptions?: PublicKeyCredentialRequestOptionsJSON;
}

export function hashMfaToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function toPasskey(row: unknown): StoredPasskey {
  const r = row as Record<string, unknown>;
  const key = r.public_key;
  return {
    id: String(r.id),
    userId: String(r.user_id),
    credentialId: String(r.credential_id),
    publicKey: key instanceof Uint8Array ? new Uint8Array(key) : new Uint8Array(),
    signCount: Number(r.sign_count ?? 0),
    transports: Array.isArray(r.transports) ? r.transports.map(String) : [],
    name: typeof r.name === "string" ? r.name : null,
    createdAt: toIso(r.created_at) ?? "",
    lastUsedAt: toIso(r.last_used_at)
  };
}

export async function listPasskeys(
  userId: string,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<StoredPasskey[]> {
  const result = await executor.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id, credential_id, public_key,
      sign_count, transports, name, created_at, last_used_at
    FROM user_passkeys
    WHERE user_id = ${userId}::uuid
    ORDER BY created_at
  `);
  return result.rows.map(toPasskey);
}

export async function findPasskeyByCredentialId(
  userId: string,
  credentialId: string
): Promise<StoredPasskey | null> {
  const result = await db.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id, credential_id, public_key,
      sign_count, transports, name, created_at, last_used_at
    FROM user_passkeys
    WHERE user_id = ${userId}::uuid AND credential_id = ${credentialId}
    LIMIT 1
  `);
  return result.rows[0] ? toPasskey(result.rows[0]) : null;
}

/**
 * Lock one passkey row of the user until the caller's transaction ends and
 * return its stored sign_count, or null when the row is gone (removed since
 * the assertion was checked). DELETE /api/auth/mfa/passkeys/:id locks the
 * same rows, so a removal and a sign-in with that passkey run one after the
 * other.
 */
export async function lockPasskeySignCount(
  passkeyId: string,
  userId: string,
  executor: SqlExecutor
): Promise<number | null> {
  const result = await executor.execute(sql`
    SELECT sign_count FROM user_passkeys
    WHERE id = ${passkeyId}::uuid AND user_id = ${userId}::uuid
    FOR UPDATE
  `);
  const row = result.rows[0] as { sign_count?: unknown } | undefined;
  return row ? Number(row.sign_count ?? 0) : null;
}

/**
 * WebAuthn signature counter rule under the passkey row lock: accept a
 * counter above the stored one, or 0 over a stored 0 (authenticators that do
 * not count). Anything else could be a cloned key or a concurrent assertion
 * that would lower the stored value; refuse it.
 */
export function isCounterAccepted(newCounter: number, storedCounter: number): boolean {
  return newCounter > storedCounter || (newCounter === 0 && storedCounter === 0);
}

/**
 * Lock the user's row until the caller's transaction ends and return its
 * current password hash, or null when the row is gone. Every password write
 * (change-password, reset-password, the admin reset) updates this row in
 * its own transaction, so a sign-in step holding the lock and a password
 * write run one after the other. POST /api/auth/login (password-only
 * session), completeMfaLogin, startLoginChallenge and the MFA management
 * writes in routes/mfa.ts take it as their first lock.
 */
export async function lockUserRow(
  userId: string,
  executor: SqlExecutor
): Promise<string | null> {
  const result = await executor.execute(sql`
    SELECT password_hash FROM users WHERE id = ${userId}::uuid FOR UPDATE
  `);
  const row = result.rows[0] as { password_hash?: unknown } | undefined;
  return typeof row?.password_hash === "string" ? row.password_hash : null;
}

const TRANSPORT_PATTERN = /^[a-z-]{1,20}$/;

/** Transports go in as one comma list so the driver passes a single parameter. */
export function transportsCsv(transports: readonly string[] | undefined): string {
  return (transports ?? []).filter((t) => TRANSPORT_PATTERN.test(t)).join(",");
}

export function setMfaCookie(res: Response, token: string): void {
  res.cookie(MFA_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: MFA_CHALLENGE_TTL_MS,
    path: MFA_COOKIE_PATH
  });
}

export function clearMfaCookie(res: Response): void {
  res.clearCookie(MFA_COOKIE_NAME, { path: MFA_COOKIE_PATH });
}

/**
 * Start the second factor after a verified password. When WebAuthn is not
 * usably configured (lib/auth/webauthn-config.ts) the challenge is still
 * created, but it offers recovery codes only and carries no passkey options.
 * Its stored challenge is then random bytes no client sees, and
 * POST /api/auth/mfa/passkey refuses while the configuration is unusable.
 *
 * The insert runs in a transaction that first locks the user's row and
 * rechecks that users.password_hash still equals `verifiedHash`, the hash
 * the password was checked against. When a password write committed in
 * between, nothing is inserted, no cookie is set, and the result is null;
 * the caller answers with its generic credential failure. The cookie is set
 * only after the insert commits.
 */
export async function startLoginChallenge(
  res: Response,
  userId: string,
  passkeys: readonly StoredPasskey[],
  verifiedHash: string
): Promise<LoginMfaResponse | null> {
  const config = getWebAuthnConfig();
  const passkeyOptions = config
    ? await generateAuthenticationOptions({
        rpID: config.rpId,
        allowCredentials: passkeys.map((p) => ({
          id: p.credentialId,
          ...(p.transports.length > 0 ? { transports: p.transports } : {})
        })),
        userVerification: "required",
        timeout: MFA_CHALLENGE_TTL_MS
      })
    : null;
  const challenge = passkeyOptions?.challenge ?? randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const created = await db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor;
    if ((await lockUserRow(userId, executor)) !== verifiedHash) return false;
    await executor.execute(sql`
      INSERT INTO mfa_challenges (user_id, purpose, challenge, token_hash, expires_at)
      VALUES (
        ${userId}::uuid, 'login', ${challenge}, ${hashMfaToken(token)},
        now() + make_interval(secs => ${MFA_CHALLENGE_TTL_MS / 1000}::integer)
      )
    `);
    return true;
  });
  if (!created) return null;
  setMfaCookie(res, token);
  return passkeyOptions
    ? { mfaRequired: true, methods: [...MFA_METHODS], passkeyOptions }
    : { mfaRequired: true, methods: ["recovery_code"] };
}

function toChallenge(row: unknown): MfaChallenge | null {
  const r = row as Record<string, unknown> | undefined;
  if (!r || typeof r.id !== "string" || typeof r.user_id !== "string") return null;
  if (typeof r.challenge !== "string") return null;
  return { id: r.id, userId: r.user_id, challenge: r.challenge };
}

/** The pending login challenge for an MFA cookie token: unexpired and unconsumed. */
export async function findLoginChallenge(token: string | undefined): Promise<MfaChallenge | null> {
  if (!token || token.length > 256) return null;
  const result = await db.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id, challenge
    FROM mfa_challenges
    WHERE token_hash = ${hashMfaToken(token)}
      AND purpose = 'login'
      AND consumed_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `);
  return toChallenge(result.rows[0]);
}

/**
 * Delete every unconsumed challenge of the user, login and register alike.
 * Each transaction that writes the user's password hash calls this on its
 * own executor, so a challenge started under the old password cannot
 * complete after the change commits. The password write's UPDATE users
 * and completeMfaLogin's lockUserRow take the same row lock, so a racing
 * completion either commits first (and the write then revokes the session
 * it created) or finds its row gone (consumeChallenge returns false).
 */
export async function invalidateMfaChallenges(
  userId: string,
  executor: SqlExecutor
): Promise<void> {
  await executor.execute(sql`
    DELETE FROM mfa_challenges
    WHERE user_id = ${userId}::uuid AND consumed_at IS NULL
  `);
}

export async function createRegisterChallenge(userId: string, challenge: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO mfa_challenges (user_id, purpose, challenge, expires_at)
    VALUES (
      ${userId}::uuid, 'register', ${challenge},
      now() + make_interval(secs => ${MFA_CHALLENGE_TTL_MS / 1000}::integer)
    )
  `);
}

/** The newest pending registration challenge of the user. */
export async function findRegisterChallenge(userId: string): Promise<MfaChallenge | null> {
  const result = await db.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id, challenge
    FROM mfa_challenges
    WHERE user_id = ${userId}::uuid
      AND purpose = 'register'
      AND consumed_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `);
  return toChallenge(result.rows[0]);
}

/**
 * Consume a challenge once. One UPDATE ... RETURNING, so of two concurrent
 * completions only one succeeds. False when it expired or was already used.
 */
export async function consumeChallenge(
  challengeId: string,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<boolean> {
  const result = await executor.execute(sql`
    UPDATE mfa_challenges
    SET consumed_at = now()
    WHERE id = ${challengeId}::uuid AND consumed_at IS NULL AND expires_at > now()
    RETURNING id
  `);
  return result.rows.length > 0;
}

export interface LocalLoginUser {
  id: string;
  email: string;
  role: UserRole;
  programId: string | null;
  name: string;
  mustResetPassword: boolean;
}

/** The challenge was consumed, expired or deleted (password write) meanwhile. */
export class MfaChallengeGone extends Error {}

export interface MfaCompletion {
  user: LocalLoginUser;
  challengeId: string;
  factor: MfaFactor;
  localLoginMode: LocalLoginMode;
  sourceIp: string | null;
}

/**
 * Finish the second factor and issue the session. One transaction:
 *   (1) lock the user's row (lockUserRow),
 *   (2) consume the challenge (throws MfaChallengeGone when it is gone),
 *   (3) `applyFactor`: the factor's own write on the same executor (passkey
 *       counter, or recovery code); it throws to refuse, which rolls back
 *       steps (1) to (3) and leaves the challenge unconsumed,
 *   (4) insert the session row.
 * A password write updates the same user row, so it either commits first
 * (and its invalidateMfaChallenges makes step 2 fail) or waits for this
 * commit and then revokes the new session with the others.
 *
 * After the commit: reset the lockout count, set the session cookie, clear
 * the MFA cookie, audit the login with the factor used, and stamp
 * lastLoginAt (best effort, as POST /login does). The lockout reset runs
 * after the commit because it writes the locked user row on another
 * connection; if it fails the request fails before any cookie is set, and
 * the session row stays unusable because its token never left the server.
 */
export async function completeMfaLogin(
  res: Response,
  completion: MfaCompletion,
  applyFactor: (executor: SqlExecutor) => Promise<void>
): Promise<void> {
  const { user, challengeId, factor, localLoginMode, sourceIp } = completion;
  const token = await db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor;
    if ((await lockUserRow(user.id, executor)) === null) throw new MfaChallengeGone();
    if (!(await consumeChallenge(challengeId, executor))) throw new MfaChallengeGone();
    await applyFactor(executor);
    return (await createSession(user.id, tx)).token;
  });
  await recordAuthSuccess(user.id);
  setSessionCookie(res, token);
  clearMfaCookie(res);
  recordSecurityEventBestEffort({
    action: user.role === "super_user" && localLoginMode === "break_glass"
      ? "auth.break_glass.login"
      : "auth.local.login",
    outcome: "success",
    actor: { id: user.id, email: user.email, role: user.role },
    programId: user.programId,
    resourceType: "session",
    sourceIp,
    details: { authMethod: "local", mfa: factor }
  });
  void db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .catch((err: unknown) => {
      console.warn("[auth] lastLoginAt update failed:", err instanceof Error ? err.message : err);
      void recordAppError({
        severity: "warning",
        source: "auth",
        operation: "last-login-update",
        error: err,
        userId: user.id
      });
    });
}
