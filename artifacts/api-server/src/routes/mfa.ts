import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { users } from "@workspace/db/schema";
import { db } from "../lib/db-client.js";
import { verifyPassword } from "../lib/auth/passwords.js";
import { getOidcConfig } from "../lib/auth/oidc.js";
import { isLocalLoginAllowed } from "../lib/auth/local-login-policy.js";
import {
  isAccountLocked,
  recordAuthFailure,
  type LockoutAccount
} from "../lib/auth/lockout.js";
import {
  completeMfaLogin,
  consumeChallenge,
  createRegisterChallenge,
  findLoginChallenge,
  findPasskeyByCredentialId,
  findRegisterChallenge,
  isCounterAccepted,
  listPasskeys,
  lockPasskeySignCount,
  lockUserAccount,
  MFA_COOKIE_NAME,
  MfaAccountRefused,
  MfaChallengeGone,
  transportsCsv,
  type MfaChallenge,
  type MfaFactor,
  type SqlExecutor
} from "../lib/auth/mfa.js";
import {
  consumeRecoveryCode,
  countUnusedRecoveryCodes,
  RECOVERY_CODE_COUNT,
  replaceRecoveryCodes
} from "../lib/auth/recovery-codes.js";
import { getWebAuthnConfig } from "../lib/auth/webauthn-config.js";
import { clientIpFrom, loginIpLimiter } from "../lib/auth/rate-limit.js";
import { mfaLoginIpLimit, mfaManageLimit } from "../lib/security/route-rate-limit.js";
import { authedUser, requireAuth, requireFreshPassword, requireSuperUser } from "../middleware/current-user.js";
import { appendSecurityEvent, recordSecurityEventBestEffort } from "../lib/security/audit.js";

/**
 * Second factor for local password login, mounted at /api/auth/mfa.
 *
 * Login step (no session yet; the MFA cookie from POST /api/auth/login
 * identifies the pending challenge):
 *   POST /passkey        WebAuthn assertion
 *   POST /recovery-code  { code }
 *
 * Enrollment (signed-in super_user, own account; every change requires the
 * current password, and a wrong password counts toward lockout; while the
 * account still has a temporary password (must_reset_password) every route
 * below answers 423 until the password is changed):
 *   GET    /status
 *   POST   /passkeys/options  { password }
 *   POST   /passkeys          { password, name?, response }
 *   DELETE /passkeys/:id      { password }
 *   POST   /recovery-codes    { password }
 *
 * Request limits (lib/security/route-rate-limit.ts): the two login-step
 * routes share a per-IP limit (mfaLoginIpLimit) on top of loginIpLimiter;
 * the enrollment routes share a per-user limit (mfaManageLimit) right after
 * requireAuth. Both answer 429 with a JSON error.
 */
export const mfaRouter = Router();

const INVALID = { error: "Invalid credentials" } as const;
const EXPIRED = {
  error: "Your sign-in expired. Enter your email and password again.",
  code: "mfa_expired"
} as const;
/** The management routes' answer to a locked account (status 429). */
const LOCKED = { error: "Too many failed attempts. Try again later." } as const;

const AssertionBody = z.object({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.object({
    clientDataJSON: z.string().min(1).max(8192),
    authenticatorData: z.string().min(1).max(8192),
    signature: z.string().min(1).max(8192),
    userHandle: z.string().max(1024).optional()
  }).passthrough(),
  clientExtensionResults: z.record(z.unknown()).default({}),
  authenticatorAttachment: z.string().max(40).optional()
}).passthrough();

const RecoveryCodeBody = z.object({ code: z.string().min(1).max(64) });

const PasswordBody = z.object({ password: z.string().min(1).max(1024) });

const RegistrationBody = z.object({
  password: z.string().min(1).max(1024),
  name: z.string().trim().max(60).optional(),
  response: z.object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: z.string().min(1).max(16384),
      attestationObject: z.string().min(1).max(65536)
    }).passthrough(),
    clientExtensionResults: z.record(z.unknown()).default({})
  }).passthrough()
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The factor's write refused under lock; `reason` goes to the audit event. */
class FactorRejected extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

interface MfaUser {
  id: string;
  email: string;
  role: LockoutAccount["role"];
  programId: string | null;
  name: string;
  isActive: boolean;
  mustResetPassword: boolean;
  lockedUntil: Date | null;
  passwordHash: string;
}

async function loadUser(userId: string): Promise<MfaUser | null> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      programId: users.programId,
      name: users.name,
      isActive: users.isActive,
      mustResetPassword: users.mustResetPassword,
      lockedUntil: users.lockedUntil,
      passwordHash: users.passwordHash
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const row = rows[0];
  return row ? { ...row, programId: row.programId ?? null } : null;
}

function account(user: MfaUser): LockoutAccount {
  return { id: user.id, email: user.email, role: user.role, programId: user.programId };
}

function countFailure(user: MfaUser, factor: MfaFactor | "password", ip: string | null): Promise<void> {
  return recordAuthFailure(account(user), { factor, sourceIp: ip }).then(
    () => undefined,
    (err: unknown) => {
      console.warn("[auth] MFA failure count update failed:", err instanceof Error ? err.message : err);
    }
  );
}

interface PendingLogin {
  challenge: MfaChallenge;
  user: MfaUser;
}

/**
 * Resolve the pending login. Responds and returns null when the challenge is
 * missing, expired or consumed (EXPIRED), or the account can no longer sign
 * in locally: deactivated, refused by LOCAL_LOGIN_MODE, or locked (INVALID).
 */
async function pendingLogin(req: Request, res: Response): Promise<PendingLogin | null> {
  const token = typeof req.cookies?.[MFA_COOKIE_NAME] === "string"
    ? (req.cookies[MFA_COOKIE_NAME] as string)
    : undefined;
  const challenge = await findLoginChallenge(token);
  if (!challenge) {
    res.status(401).json(EXPIRED);
    return null;
  }
  const user = await loadUser(challenge.userId);
  if (
    !user ||
    !user.isActive ||
    !isLocalLoginAllowed(getOidcConfig().localLoginMode, user.role) ||
    isAccountLocked(user)
  ) {
    res.status(401).json(INVALID);
    return null;
  }
  return { challenge, user };
}

function auditFailure(user: MfaUser, factor: MfaFactor, ip: string | null, reason: string): void {
  recordSecurityEventBestEffort({
    action: "auth.mfa.verify",
    outcome: "denied",
    actor: { id: user.id, email: user.email, role: user.role },
    programId: user.programId,
    resourceType: "session",
    sourceIp: ip,
    details: { authMethod: "local", factor, reason }
  });
}

function sessionUser(user: MfaUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    programId: user.programId,
    name: user.name,
    mustResetPassword: user.mustResetPassword
  };
}

/**
 * Run completeMfaLogin for the pending login. Responds and returns false
 * when the challenge is gone (EXPIRED), the account is locked or inactive
 * under the user row lock (INVALID; not counted), or the factor's write
 * refused (INVALID; counted toward lockout and audited as a rejected
 * factor).
 */
async function completeLogin(
  req: Request,
  res: Response,
  pending: PendingLogin,
  factor: MfaFactor,
  applyFactor: (executor: SqlExecutor) => Promise<void>
): Promise<boolean> {
  const { challenge, user } = pending;
  const ip = clientIpFrom(req);
  try {
    await completeMfaLogin(
      res,
      { user, challengeId: challenge.id, factor, localLoginMode: getOidcConfig().localLoginMode, sourceIp: ip },
      applyFactor
    );
    return true;
  } catch (err) {
    if (err instanceof MfaChallengeGone) {
      res.status(401).json(EXPIRED);
      return false;
    }
    // Locked (or deactivated) after pendingLogin's unlocked check: the same
    // answer pendingLogin gives a locked account.
    if (err instanceof MfaAccountRefused) {
      res.status(401).json(INVALID);
      return false;
    }
    if (err instanceof FactorRejected) {
      await countFailure(user, factor, ip);
      auditFailure(user, factor, ip, err.reason);
      res.status(401).json(INVALID);
      return false;
    }
    throw err;
  }
}

mfaRouter.post("/passkey", mfaLoginIpLimit, async (req, res, next) => {
  try {
    const ip = clientIpFrom(req);
    if (!loginIpLimiter.hit(ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
      return;
    }
    const pending = await pendingLogin(req, res);
    if (!pending) return;
    const { challenge, user } = pending;

    const parsed = AssertionBody.safeParse(req.body);
    const config = getWebAuthnConfig();
    const passkey = parsed.success
      ? await findPasskeyByCredentialId(user.id, parsed.data.id)
      : null;
    let newCounter: number | null = null;
    if (parsed.success && config && passkey) {
      try {
        const result = await verifyAuthenticationResponse({
          response: parsed.data as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: config.origins,
          expectedRPID: config.rpId,
          credential: {
            id: passkey.credentialId,
            publicKey: passkey.publicKey,
            counter: passkey.signCount,
            transports: passkey.transports
          },
          requireUserVerification: true
        });
        if (result.verified) newCounter = result.authenticationInfo.newCounter;
      } catch {
        newCounter = null;
      }
    }
    if (newCounter === null || !passkey) {
      await countFailure(user, "passkey", ip);
      auditFailure(user, "passkey", ip, config ? "assertion_rejected" : "webauthn_unconfigured");
      res.status(401).json(INVALID);
      return;
    }

    // Challenge, counter and session commit together (completeMfaLogin).
    // Under the passkey row lock the row must still exist (a removal may
    // have committed since the assertion was checked) and the counter must
    // not fall back below what a concurrent sign-in stored meanwhile.
    const counter = newCounter;
    const completed = await completeLogin(req, res, pending, "passkey", async (executor) => {
      const stored = await lockPasskeySignCount(passkey.id, user.id, executor);
      if (stored === null) throw new FactorRejected("passkey_removed");
      if (!isCounterAccepted(counter, stored)) throw new FactorRejected("counter_not_increased");
      await executor.execute(sql`
        UPDATE user_passkeys
        SET sign_count = ${counter}, last_used_at = now()
        WHERE id = ${passkey.id}::uuid
      `);
    });
    if (completed) res.json({ user: sessionUser(user) });
  } catch (err) {
    next(err);
  }
});

mfaRouter.post("/recovery-code", mfaLoginIpLimit, async (req, res, next) => {
  try {
    const ip = clientIpFrom(req);
    if (!loginIpLimiter.hit(ip)) {
      res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
      return;
    }
    const pending = await pendingLogin(req, res);
    if (!pending) return;
    const { user } = pending;

    const parsed = RecoveryCodeBody.safeParse(req.body);
    if (!parsed.success) {
      await countFailure(user, "recovery_code", ip);
      auditFailure(user, "recovery_code", ip, "code_rejected");
      res.status(401).json(INVALID);
      return;
    }
    // The code is spent only together with the challenge and the session:
    // a wrong code, or a challenge consumed meanwhile, rolls back both.
    const completed = await completeLogin(req, res, pending, "recovery_code", async (executor) => {
      if (!(await consumeRecoveryCode(user.id, parsed.data.code, executor))) {
        throw new FactorRejected("code_rejected");
      }
    });
    if (completed) res.json({ user: sessionUser(user) });
  } catch (err) {
    next(err);
  }
});

// Enrollment: the signed-in super_user manages the passkeys and recovery
// codes of their own account.

/**
 * Check the current password from the request body. Responds and returns
 * null on a malformed body, a locked account or a wrong password; the wrong
 * password counts toward lockout.
 */
async function requireCurrentPassword(req: Request, res: Response): Promise<MfaUser | null> {
  const parsed = PasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your current password." });
    return null;
  }
  const user = await loadUser(authedUser(req).id);
  if (!user || !user.isActive) {
    res.status(401).json({ error: "Unauthorized" });
    return null;
  }
  if (isAccountLocked(user)) {
    res.status(429).json(LOCKED);
    return null;
  }
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) {
    await countFailure(user, "password", clientIpFrom(req));
    res.status(401).json({ error: "Current password is incorrect" });
    return null;
  }
  return user;
}

const UNAUTHORIZED = { error: "Unauthorized" } as const;

/** Why lockVerifiedAccount refused: "stale" answers 401, "locked" 429. */
type AccountRefusal = "stale" | "locked";

/**
 * First statement of every MFA management transaction: lock the user's row
 * (lockUserAccount) and recheck, under that lock, what requireCurrentPassword
 * checked without it. Returns "stale" when the row is gone, the account is
 * inactive, or its password hash no longer equals the one
 * requireCurrentPassword verified; "locked" when the account is locked now
 * (isAccountLocked, so demo accounts stay exempt); null when the change may
 * proceed. On a refusal the caller writes nothing and answers with
 * sendAccountRefusal.
 *
 * A password write (change, reset, admin reset) and a failure that reaches
 * the lockout threshold (recordAuthFailure) update the same row, so each
 * either committed first and is seen here, or waits until the caller's
 * transaction ends. The user row is locked before any passkey or
 * recovery-code row, the same order completeMfaLogin uses.
 */
async function lockVerifiedAccount(user: MfaUser, executor: SqlExecutor): Promise<AccountRefusal | null> {
  const current = await lockUserAccount(user.id, executor);
  if (!current || !current.isActive || current.passwordHash !== user.passwordHash) return "stale";
  if (isAccountLocked({ email: user.email, lockedUntil: current.lockedUntil })) return "locked";
  return null;
}

/** The same answers requireCurrentPassword gives: 429 locked, 401 otherwise. */
function sendAccountRefusal(res: Response, refusal: AccountRefusal): void {
  if (refusal === "locked") res.status(429).json(LOCKED);
  else res.status(401).json(UNAUTHORIZED);
}

function auditChange(req: Request, user: MfaUser, action: string, resourceType: string, resourceId: string | null, details: Record<string, unknown> = {}): void {
  recordSecurityEventBestEffort({
    action,
    outcome: "success",
    actor: { id: user.id, email: user.email, role: user.role },
    programId: user.programId,
    resourceType,
    resourceId,
    sourceIp: clientIpFrom(req),
    details
  });
}

const UNAVAILABLE = {
  error: "Passkey sign-in is not configured on this server. Set WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS, or APP_BASE_URL.",
  code: "webauthn_unconfigured"
} as const;

mfaRouter.get("/status", requireAuth, mfaManageLimit, requireSuperUser, requireFreshPassword, async (req, res, next) => {
  try {
    const user = authedUser(req);
    const [passkeys, unusedRecoveryCodes] = await Promise.all([
      listPasskeys(user.id),
      countUnusedRecoveryCodes(user.id)
    ]);
    res.json({
      passkeyAvailable: getWebAuthnConfig() !== null,
      passkeys: passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        lastUsedAt: p.lastUsedAt
      })),
      unusedRecoveryCodes
    });
  } catch (err) {
    next(err);
  }
});

mfaRouter.post("/passkeys/options", requireAuth, mfaManageLimit, requireSuperUser, requireFreshPassword, async (req, res, next) => {
  try {
    const config = getWebAuthnConfig();
    if (!config) {
      res.status(503).json(UNAVAILABLE);
      return;
    }
    const user = await requireCurrentPassword(req, res);
    if (!user) return;
    const existing = await listPasskeys(user.id);
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpId,
      userName: user.email,
      userDisplayName: user.name,
      userID: new TextEncoder().encode(user.id),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.credentialId,
        ...(p.transports.length > 0 ? { transports: p.transports } : {})
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      timeout: 5 * 60 * 1000
    });
    await createRegisterChallenge(user.id, options.challenge);
    res.json({ options });
  } catch (err) {
    next(err);
  }
});

mfaRouter.post("/passkeys", requireAuth, mfaManageLimit, requireSuperUser, requireFreshPassword, async (req, res, next) => {
  try {
    const config = getWebAuthnConfig();
    if (!config) {
      res.status(503).json(UNAVAILABLE);
      return;
    }
    const parsed = RegistrationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const user = await requireCurrentPassword(req, res);
    if (!user) return;
    const challenge = await findRegisterChallenge(user.id);
    if (!challenge) {
      res.status(409).json({ error: "The passkey request expired. Try adding it again." });
      return;
    }

    let credential: { id: string; publicKey: Uint8Array; counter: number; transports?: string[] } | null = null;
    try {
      const result = await verifyRegistrationResponse({
        response: parsed.data.response as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: config.origins,
        expectedRPID: config.rpId,
        requireUserVerification: true
      });
      if (result.verified) credential = result.registrationInfo.credential;
    } catch {
      credential = null;
    }
    if (!credential) {
      res.status(400).json({ error: "The passkey could not be verified. Try again." });
      return;
    }

    const name = parsed.data.name || "Passkey";
    const saved = credential;
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const refusal = await lockVerifiedAccount(user, executor);
      if (refusal) return { refusal, passkeyId: null };
      if (!(await consumeChallenge(challenge.id, executor))) return { refusal: null, passkeyId: null };
      const result = await executor.execute(sql`
        INSERT INTO user_passkeys (user_id, credential_id, public_key, sign_count, transports, name)
        VALUES (
          ${user.id}::uuid,
          ${saved.id},
          ${Buffer.from(saved.publicKey)},
          ${saved.counter},
          NULLIF(string_to_array(${transportsCsv(saved.transports)}, ','), '{}'::text[]),
          ${name}
        )
        ON CONFLICT (credential_id) DO NOTHING
        RETURNING id::text AS id
      `);
      const row = result.rows[0] as { id?: string } | undefined;
      return { refusal: null, passkeyId: row?.id ?? null };
    });
    if (outcome.refusal) {
      sendAccountRefusal(res, outcome.refusal);
      return;
    }
    const passkeyId = outcome.passkeyId;
    if (!passkeyId) {
      res.status(409).json({ error: "This passkey is already registered, or the request expired." });
      return;
    }
    auditChange(req, user, "auth.mfa.passkey.added", "user_passkey", passkeyId, { name });
    res.status(201).json({ passkey: { id: passkeyId, name, createdAt: new Date().toISOString(), lastUsedAt: null } });
  } catch (err) {
    next(err);
  }
});

mfaRouter.delete("/passkeys/:id", requireAuth, mfaManageLimit, requireSuperUser, requireFreshPassword, async (req, res, next) => {
  try {
    const passkeyId = req.params.id ?? "";
    if (!UUID_PATTERN.test(passkeyId)) {
      res.status(404).json({ error: "Passkey not found" });
      return;
    }
    const user = await requireCurrentPassword(req, res);
    if (!user) return;
    const keepLast = getOidcConfig().localLoginMode === "break_glass";
    // In break_glass mode the emergency account cannot sign in without a
    // passkey, so its last one stays until another is added. The check and
    // the delete run in one transaction that locks the user's row and
    // rechecks the password and lock state (lockVerifiedAccount), then locks
    // every passkey row of the user (FOR UPDATE): a concurrent delete waits,
    // then sees the row this one removed as gone, so two deletes cannot
    // remove the last two.
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const refusal = await lockVerifiedAccount(user, executor);
      if (refusal) return refusal;
      const locked = await executor.execute(sql`
        SELECT id::text AS id FROM user_passkeys
        WHERE user_id = ${user.id}::uuid
        FOR UPDATE
      `);
      const ids = locked.rows.map((row) => String((row as { id?: unknown }).id));
      if (!ids.includes(passkeyId.toLowerCase())) return "missing" as const;
      if (keepLast && ids.length === 1) return "last" as const;
      const result = await executor.execute(sql`
        DELETE FROM user_passkeys WHERE id = ${passkeyId}::uuid AND user_id = ${user.id}::uuid
        RETURNING id
      `);
      return result.rows.length > 0 ? ("deleted" as const) : ("missing" as const);
    });
    if (outcome === "stale" || outcome === "locked") {
      sendAccountRefusal(res, outcome);
      return;
    }
    if (outcome === "missing") {
      res.status(404).json({ error: "Passkey not found" });
      return;
    }
    if (outcome === "last") {
      res.status(409).json({ error: "Add another passkey before removing the last one." });
      return;
    }
    auditChange(req, user, "auth.mfa.passkey.removed", "user_passkey", passkeyId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

mfaRouter.post("/recovery-codes", requireAuth, mfaManageLimit, requireSuperUser, requireFreshPassword, async (req, res, next) => {
  try {
    const user = await requireCurrentPassword(req, res);
    if (!user) return;
    // The replacement and its audit event commit together: if the event
    // cannot be appended, the old codes stay and the request fails. A
    // password write, deactivation or lockout committed since the check
    // leaves the old codes and returns none (lockVerifiedAccount).
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const refusal = await lockVerifiedAccount(user, executor);
      if (refusal) return { refusal, codes: null };
      const replaced = await replaceRecoveryCodes(user.id, executor);
      await appendSecurityEvent(
        {
          action: "auth.mfa.recovery_codes.generated",
          outcome: "success",
          actor: { id: user.id, email: user.email, role: user.role },
          programId: user.programId,
          resourceType: "user",
          resourceId: user.id,
          sourceIp: clientIpFrom(req),
          details: { count: RECOVERY_CODE_COUNT }
        },
        executor
      );
      return { refusal: null, codes: replaced };
    });
    if (outcome.refusal) {
      sendAccountRefusal(res, outcome.refusal);
      return;
    }
    res.json({ codes: outcome.codes });
  } catch (err) {
    next(err);
  }
});
