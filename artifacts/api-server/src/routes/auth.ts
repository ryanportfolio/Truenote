import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { passwordResetTokens, sessions, users } from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/auth/passwords.js";
import {
  createSession,
  clearSessionCookie,
  deleteSessionByToken,
  generateToken,
  hashToken,
  setSessionCookie,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS
} from "../lib/auth/sessions.js";
import { getOidcConfig } from "../lib/auth/oidc.js";
import { isLocalLoginAllowed } from "../lib/auth/local-login-policy.js";
import {
  invalidateMfaChallenges,
  listPasskeys,
  lockUserAccount,
  startLoginChallenge,
  type SqlExecutor
} from "../lib/auth/mfa.js";
import {
  isAccountLocked,
  recordAuthFailure,
  recordAuthSuccess
} from "../lib/auth/lockout.js";
import {
  createResetToken,
  hashResetToken,
  lookupResetTokenUserId
} from "../lib/auth/password-reset.js";
import {
  clientIpFrom,
  forgotPasswordEmailLimiter,
  forgotPasswordIpLimiter,
  loginIpLimiter
} from "../lib/auth/rate-limit.js";
import {
  authedUser,
  DEMO_WRITE_BLOCKED_MESSAGE,
  requireAuth
} from "../middleware/current-user.js";
import { workloadRateLimitMiddleware } from "../middleware/workload-rate-limit.js";
import { isDemoEmail } from "../lib/auth/demo-accounts.js";
import { getMinPasswordLength } from "../lib/config.js";
import { getEmailSender } from "../lib/email/sender.js";
import { resolveAppBaseUrl } from "../lib/email/links.js";
import { recordAppError } from "../lib/observability/error-log.js";
import { renderResetEmail } from "../lib/email/templates.js";
import { recordSecurityEventBestEffort } from "../lib/security/audit.js";

export const authRouter = Router();

const LoginBody = z.object({
  // .trim() matches the CreateBody convention in routes/admin/users.ts
  // — without it, a paste with trailing whitespace fails zod's
  // .email() validation rather than normalizing transparently.
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024)
});

// Read once at module load so every login / change-password request
// sees the same value within a process. Operators tune via the env
// var and restart the api-server workflow to roll the change out.
const MIN_PASSWORD_LENGTH = getMinPasswordLength();

const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .max(1024)
});

const ForgotPasswordBody = z.object({
  email: z.string().trim().email().max(254)
});

const ResetPasswordBody = z.object({
  // The token shipped in the reset link. base64url is [A-Za-z0-9_-];
  // bound the length to something reasonable rather than match exactly
  // so we don't have to rev the validator if the token width ever
  // changes. Empty / oversized requests fail fast on the schema rather
  // than burning a hash lookup.
  token: z
    .string()
    .min(16)
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/, "Token has an unexpected format"),
  newPassword: z
    .string()
    .min(
      MIN_PASSWORD_LENGTH,
      `New password must be at least ${MIN_PASSWORD_LENGTH} characters`
    )
    .max(1024)
});

/**
 * Lazily-cached argon2 hash of a random nonsense password, used to
 * equalize the timing of the "email not found" path with the "email
 * found, wrong password" path. Without this, a missing-email response
 * returns in <5ms (no argon2 work) while a real verify takes ~50ms; a
 * stopwatch attacker can enumerate which emails exist in seconds.
 *
 * Computed once per process. The plaintext is discarded immediately —
 * we only ever need the hash for the dummy-verify side effect.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(randomBytes(32).toString("hex"));
  }
  return dummyHashPromise;
}

/**
 * Email+password login. Returns the user payload AND sets a session
 * cookie. On any failure path the response is a generic 401 with the same
 * body so we don't leak which of (email-not-found, wrong-password,
 * user-deactivated, refused by LOCAL_LOGIN_MODE, locked out) tripped the
 * rejection; a hostile script can't
 * enumerate accounts from the response shape.
 */
authRouter.post("/login", async (req, res, next) => {
  try {
    // Per-IP throttle BEFORE any Argon2 work, so a flood can't force
    // unbounded verifications from one source. Very generous (see
    // loginIpLimiter) so a shared-office IP is never locked out. A 429
    // here leaks nothing about accounts — it reflects only the
    // requester's own request rate.
    const ip = clientIpFrom(req);
    if (!loginIpLimiter.hit(ip)) {
      res.status(429).json({
        error: "Too many login attempts. Try again in a few minutes."
      });
      return;
    }

    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const { email: rawEmail, password } = parsed.data;
    const email = rawEmail.toLowerCase();

    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        role: users.role,
        programId: users.programId,
        name: users.name,
        isActive: users.isActive,
        mustResetPassword: users.mustResetPassword,
        lockedUntil: users.lockedUntil
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const row = rows[0];
    const oidc = getOidcConfig();

    // Every refusal below runs a dummy verify against a cached
    // random-password hash and returns the same 401, so neither timing nor
    // response shape tells a missing, deactivated, policy-refused or
    // locked account apart from a wrong password. The stored hash is
    // verified only for an account allowed to log in right now, so a
    // refused or locked account never confirms a correct password.
    const refuse = async () => {
      await verifyPassword(password, await getDummyHash());
      res.status(401).json({ error: "Invalid credentials" });
    };

    if (!row || !row.isActive) {
      await refuse();
      return;
    }

    const actor = { id: row.id, email: row.email, role: row.role };
    if (!isLocalLoginAllowed(oidc.localLoginMode, row.role)) {
      recordSecurityEventBestEffort({
        action: "auth.local.login",
        outcome: "denied",
        actor,
        programId: row.programId,
        resourceType: "session",
        sourceIp: ip,
        details: {
          authMethod: "local",
          reason: "local_login_mode",
          localLoginMode: oidc.localLoginMode
        }
      });
      await refuse();
      return;
    }

    if (isAccountLocked(row)) {
      recordSecurityEventBestEffort({
        action: "auth.local.login",
        outcome: "denied",
        actor,
        programId: row.programId,
        resourceType: "session",
        sourceIp: ip,
        details: { authMethod: "local", reason: "account_locked" }
      });
      await refuse();
      return;
    }

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      // Not awaited: an extra DB round trip only on this branch would let
      // a stopwatch tell an existing account from a missing one. A failed
      // write is logged; the attempt is still refused.
      void recordAuthFailure(
        { id: row.id, email: row.email, role: row.role, programId: row.programId },
        { factor: "password", sourceIp: ip }
      ).catch((err: unknown) => {
        console.warn(
          "[auth] failed-login count update failed:",
          err instanceof Error ? err.message : err
        );
        void recordAppError({
          severity: "warning",
          source: "auth",
          operation: "login-failure-count",
          error: err,
          userId: row.id
        });
      });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // Second factor (lib/auth/mfa.ts). A user with a passkey gets no
    // session here: the response starts the MFA step, and routes/mfa.ts
    // resets the lockout count and issues the session once a passkey or
    // recovery code verifies.
    //
    // Both the challenge insert and the session insert below run in a
    // transaction that locks the user's row and rechecks the password hash
    // just verified: a password write that committed after the check makes
    // this attempt fail with the generic 401 and write nothing.
    const passkeys = await listPasskeys(row.id);
    if (passkeys.length > 0) {
      const challenge = await startLoginChallenge(res, row.id, passkeys, row.passwordHash);
      if (!challenge) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
      }
      if (!challenge.methods.includes("passkey")) {
        // WebAuthn is not usably configured (lib/auth/webauthn-config.ts).
        // The second factor still applies: the challenge offers recovery
        // codes only, so the emergency account is not locked out by a
        // configuration mistake. Record it so the mistake gets fixed.
        console.warn("[auth] WebAuthn is not configured; login MFA offers recovery codes only");
        recordSecurityEventBestEffort({
          action: "auth.mfa.webauthn_unconfigured",
          outcome: "failure",
          actor,
          programId: row.programId,
          resourceType: "session",
          sourceIp: ip,
          details: { authMethod: "local", reason: "webauthn_unconfigured", methods: challenge.methods }
        });
      }
      res.json(challenge);
      return;
    }
    if (oidc.localLoginMode === "break_glass" && row.role === "super_user") {
      // The emergency account must hold a passkey before it can sign in.
      recordSecurityEventBestEffort({
        action: "auth.break_glass.mfa_missing",
        outcome: "denied",
        actor,
        programId: row.programId,
        resourceType: "session",
        sourceIp: ip,
        details: { authMethod: "local", reason: "no_passkey" }
      });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    // The lock state and the passkey list above were read before any lock.
    // Under the user's row lock, read them again:
    //   - a lock committed since the isAccountLocked check (a concurrent
    //     failure reached the threshold), or a deactivation, refuses this
    //     attempt as a locked attempt is refused, and the lock stays;
    //   - a first passkey enrolled since then means this attempt needs the
    //     second factor, so it gets no session and the generic 401 (the
    //     next attempt starts the MFA step). Passkey writes in
    //     routes/mfa.ts take the same row lock first.
    // The lockout reset runs in the same transaction, so it commits only
    // together with the session.
    const outcome = await db.transaction(async (tx) => {
      const executor = tx as unknown as SqlExecutor;
      const current = await lockUserAccount(row.id, executor);
      if (!current || current.passwordHash !== row.passwordHash || !current.isActive) {
        return { refused: "changed" as const };
      }
      if (isAccountLocked({ email: row.email, lockedUntil: current.lockedUntil })) {
        return { refused: "account_locked" as const };
      }
      if ((await listPasskeys(row.id, executor)).length > 0) {
        return { refused: "changed" as const };
      }
      const { token: sessionToken } = await createSession(row.id, tx);
      await recordAuthSuccess(row.id, tx);
      return { token: sessionToken };
    });
    if (outcome.refused) {
      if (outcome.refused === "account_locked") {
        recordSecurityEventBestEffort({
          action: "auth.local.login",
          outcome: "denied",
          actor,
          programId: row.programId,
          resourceType: "session",
          sourceIp: ip,
          details: { authMethod: "local", reason: "account_locked" }
        });
      }
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = outcome.token;
    setSessionCookie(res, token);
    recordSecurityEventBestEffort({
      action: row.role === "super_user" && oidc.localLoginMode === "break_glass"
        ? "auth.break_glass.login"
        : "auth.local.login",
      outcome: "success",
      actor: { id: row.id, email: row.email, role: row.role },
      programId: row.programId,
      resourceType: "session",
      sourceIp: ip,
      details: { authMethod: "local" }
    });

    // Best-effort bookkeeping. If this update throws, Express's error
    // handler would send a 500 — but the Set-Cookie header is ALREADY
    // queued on the response by setSessionCookie, so the browser would
    // store a valid session while the user sees "login failed." Fire and
    // forget keeps the response contract honest: a 200 means logged in,
    // and a stale lastLoginAt is recoverable on the next login.
    void db
      .update(users)
      .set({ lastLoginAt: new Date() })
      .where(eq(users.id, row.id))
      .catch((err: unknown) => {
        console.warn(
          "[auth] lastLoginAt update failed:",
          err instanceof Error ? err.message : err
        );
        void recordAppError({
          severity: "warning",
          source: "auth",
          operation: "last-login-update",
          error: err,
          userId: row.id
        });
      });

    res.json({
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        programId: row.programId ?? null,
        name: row.name,
        mustResetPassword: row.mustResetPassword
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Logout. Idempotent — calling with no session cookie still 204s. We
 * always clear the cookie on the response even if the server-side delete
 * was a no-op, so a stale cookie on the client doesn't outlive the
 * server-side row.
 */
authRouter.post("/logout", async (req, res, next) => {
  try {
    const token =
      typeof req.cookies?.[SESSION_COOKIE_NAME] === "string"
        ? req.cookies[SESSION_COOKIE_NAME]
        : undefined;
    await deleteSessionByToken(token);
    clearSessionCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** change-password found the request's session gone or expired under lock. */
class CurrentSessionGone extends Error {}

/**
 * Change own password. Required for first-login users (`must_reset_password
 * = true`) — but ALSO callable by any authenticated user to rotate their
 * password voluntarily.
 *
 * Side effect: every existing session for this user is deleted, including
 * the one they're using right now. We immediately issue a fresh session so
 * the actor doesn't get logged out by their own password change. Stolen
 * cookies on the old password are dead instantly. The fresh session of an
 * oidc sign-in keeps the original auth_method, auth_time and expires_at.
 */
authRouter.post("/change-password", requireAuth, workloadRateLimitMiddleware("password_change"), async (req, res, next) => {
  try {
    const user = authedUser(req);
    // Demo credentials are published on /api/config — that is the login
    // feature. Letting any visitor rotate the password would lock every
    // other visitor out of the shared demo, so demo accounts can't
    // change their own password.
    if (isDemoEmail(user.email)) {
      res.status(403).json({ error: DEMO_WRITE_BLOCKED_MESSAGE });
      return;
    }
    const parsed = ChangePasswordBody.safeParse(req.body);
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Invalid request";
      res.status(400).json({ error: message });
      return;
    }
    const { currentPassword, newPassword } = parsed.data;

    const rows = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const ok = await verifyPassword(currentPassword, row.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    if (newPassword === currentPassword) {
      res.status(400).json({ error: "New password must differ from current" });
      return;
    }

    const passwordHash = await hashPassword(newPassword);
    const sessionToken =
      typeof req.cookies?.[SESSION_COOKIE_NAME] === "string"
        ? (req.cookies[SESSION_COOKIE_NAME] as string)
        : undefined;

    // Password change is one ATOMIC transaction:
    //   (1) update the password hash + clear must_reset_password
    //   (2) read and lock the session this request runs on
    //   (3) delete every existing session (including this one)
    //   (4) insert the replacement session
    //
    // Without the transaction, a transient DB failure between (1) and (3)
    // would leave the password new but the OLD sessions — including any
    // stolen cookies — still valid. The whole point of revoke-then-reissue
    // is the security contract "stolen cookies on the old password are
    // dead instantly"; that contract requires all-or-nothing.
    //
    // The replacement of an oidc session keeps its auth_method, auth_time
    // and expires_at, so the SSO idle and absolute limits still apply and
    // LOCAL_LOGIN_MODE does not end it as a password session. A local
    // session is replaced by a new 7-day local session. The users row is
    // locked by (1) before the session row, the order the password resets
    // use. When the current session is gone or expired by (2) (logout,
    // revoke), the change rolls back and the request gets 401.
    const replaced = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: false })
        .where(eq(users.id, user.id));
      const current = sessionToken
        ? (
            await tx
              .select({
                authMethod: sessions.authMethod,
                authTime: sessions.authTime,
                expiresAt: sessions.expiresAt
              })
              .from(sessions)
              .where(
                and(
                  eq(sessions.tokenHash, hashToken(sessionToken)),
                  eq(sessions.userId, user.id),
                  gt(sessions.expiresAt, new Date())
                )
              )
              .for("update")
              .limit(1)
          )[0]
        : undefined;
      if (!current) throw new CurrentSessionGone();
      await invalidateMfaChallenges(user.id, tx as unknown as SqlExecutor);
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      const carryOver = current.authMethod === "oidc" ? current : undefined;
      const created = await createSession(user.id, tx, carryOver);
      return { ...created, carriedOver: carryOver !== undefined };
    }).catch((err: unknown) => {
      if (err instanceof CurrentSessionGone) return null;
      throw err;
    });
    if (!replaced) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    setSessionCookie(
      res,
      replaced.token,
      replaced.carriedOver
        ? { maxAgeMs: Math.max(0, replaced.expiresAt.getTime() - Date.now()) }
        : {}
    );

    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        programId: user.programId,
        name: user.name,
        mustResetPassword: false
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/forgot-password — request a reset link.
 *
 * Always returns 204 regardless of whether the email is known. Two
 * reasons:
 *   1. Account enumeration — a "we sent it" / "no such user" split
 *      lets an attacker probe the user table with a stopwatch.
 *   2. Inactive users — silently skipped; reactivating them is an
 *      admin path, not a self-service one. Surfacing "this account
 *      is inactive" would leak the same data.
 *
 * The actual email send happens fire-and-forget after the 204 is
 * returned, so a slow upstream (Resend, DNS) doesn't pin the request
 * thread. Send failures are logged; the user sees the same outcome
 * either way (no email arrives → they retry).
 *
 * Rate limiting is intentionally NOT included in Phase 2.5 — a real
 * deployment should add per-email + per-IP limits to avoid being a
 * spam relay. Tracked as a follow-up.
 */
authRouter.post("/forgot-password", async (req, res, next) => {
  try {
    const parsed = ForgotPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const email = parsed.data.email.trim().toLowerCase();

    // Per-IP throttle. Returns 429 directly because the IP is the
    // requester's own attribute — telling them their own request rate
    // leaks nothing. The per-email throttle below is silent (drop the
    // send, still 204) because the email is the victim's attribute,
    // and a 429 on that channel would re-open the enumeration window
    // forgot-password is designed to close.
    const ip = clientIpFrom(req);
    if (!forgotPasswordIpLimiter.hit(ip)) {
      res
        .status(429)
        .json({ error: "Too many reset requests. Try again in a few minutes." });
      return;
    }
    const emailAllowed = forgotPasswordEmailLimiter.hit(email);

    // Acknowledge first; do the lookup + email out-of-band. This way
    // the response time is constant whether the email is known or
    // unknown — closes the same timing channel the login endpoint
    // closes via the dummy argon2 verify.
    res.status(204).end();

    // Demo accounts can't reset their published password — same
    // shared-demo-lockout rationale as the change-password guard. The
    // 204 already went out (indistinguishable from any other email),
    // we just never issue a token or send anything.
    if (isDemoEmail(email)) {
      return;
    }

    // Per-email rate limit landed AFTER the response so timing is
    // consistent. We still ran .hit() on the email above to record
    // the request; if it returned false, skip the actual lookup +
    // send in the async block.
    if (!emailAllowed) {
      console.log(
        `[auth] forgot-password per-email rate-limit hit; suppressing send for ${email}`
      );
      return;
    }

    // From here on we're past the response — no res.* calls. Errors
    // are logged, not surfaced.
    //
    // Capture the base URL synchronously from the live request rather
    // than inside the async IIFE — the Request object becomes
    // unreliable to read from after the response cycle ends in some
    // middleware stacks. If APP_BASE_URL is unset in production,
    // resolveAppBaseUrl returns null (the index.ts startup check
    // should have already refused to boot, but defense in depth).
    const baseUrl = resolveAppBaseUrl(req);
    void (async () => {
      try {
        if (baseUrl === null) {
          console.warn(
            "[auth] forgot-password: APP_BASE_URL not set in production; " +
              "refusing to send a reset email with a header-derived URL"
          );
          void recordAppError({
            severity: "error",
            source: "configuration",
            operation: "forgot-password-base-url",
            error: new Error("APP_BASE_URL is not set in production")
          });
          return;
        }
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            isActive: users.isActive
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        const row = rows[0];
        if (!row || !row.isActive) return;

        const { token, expiresAt } = await createResetToken(row.id);
        const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
        const { subject, html, text } = renderResetEmail({
          name: row.name,
          resetUrl,
          expiresAt
        });
        const sender = getEmailSender();
        await sender.send({ to: row.email, subject, html, text });
      } catch (err) {
        console.warn(
          "[auth] forgot-password background send failed:",
          err instanceof Error ? err.message : err
        );
        void recordAppError({
          severity: "error",
          source: "email",
          operation: "forgot-password-send",
          error: err
        });
      }
    })();
  } catch (err) {
    next(err);
  }
});

class ResetPasswordRejectedError extends Error {
  constructor(readonly status: 400 | 403, message: string) {
    super(message);
  }
}

/**
 * POST /api/auth/reset-password — consume a reset link, set new
 * password, and sign the user in unless a second factor is required.
 *
 * Atomic transaction:
 *   (1) re-verify the token is unused + unexpired (under the row
 *       lock — the lookup above the transaction is racy)
 *   (2) mark token used
 *   (3) update password_hash + clear must_reset_password
 *   (4) delete every session for this user
 *   (5) issue a fresh session, only when /login would issue one from the
 *       password alone. A user with a passkey, or the break_glass
 *       super_user, gets `{ passwordReset: true, signInRequired: true }`
 *       and no cookie, and signs in through /login and its second factor.
 *
 * Same all-or-nothing rationale as change-password: if we updated the
 * password but failed to revoke sessions, stolen cookies on the old
 * password would still work — the whole point of password reset is
 * that they don't.
 */
authRouter.post("/reset-password", async (req, res, next) => {
  try {
    const parsed = ResetPasswordBody.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "Invalid request";
      res.status(400).json({ error: message });
      return;
    }
    const { token, newPassword } = parsed.data;

    // Up-front check so an obviously-bad token returns immediately
    // (saves an argon2 hash compute for the common "expired link"
    // case). The real validation happens again under the transaction
    // because the token could be consumed between this lookup and
    // the write — see the in-tx re-check below.
    const userIdPreflight = await lookupResetTokenUserId(token);
    if (!userIdPreflight) {
      res
        .status(400)
        .json({ error: "This reset link is invalid or has expired" });
      return;
    }

    const tokenHash = hashResetToken(token);
    const passwordHash = await hashPassword(newPassword);

    const result = await db.transaction(async (tx) => {
      // Re-check under the transaction. The atomic UPDATE...RETURNING
      // is the canonical "consume" — if zero rows come back, somebody
      // else used the token between the preflight and now.
      const consumed = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, tokenHash),
            gt(passwordResetTokens.expiresAt, new Date()),
            isNull(passwordResetTokens.usedAt)
          )
        )
        .returning({ userId: passwordResetTokens.userId });
      const consumedRow = consumed[0];
      if (!consumedRow) {
        throw new ResetPasswordRejectedError(400, "This reset link is invalid or has expired");
      }

      const userId = consumedRow.userId;

      // Refuse to log inactive users back in even if the token was
      // valid. (Should only happen if an admin deactivated the user
      // between issue and consume.)
      const userRows = await tx
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          programId: users.programId,
          name: users.name,
          isActive: users.isActive
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const user = userRows[0];
      if (!user || !user.isActive) {
        throw new ResetPasswordRejectedError(400, "This reset link is invalid or has expired");
      }

      // Belt-and-suspenders: forgot-password never issues tokens for
      // demo emails, but a token minted before the account became a
      // demo account (or via a future code path) must still not rotate
      // a published demo password. Generic invalid-link response — no
      // need to advertise the account's demo status here.
      if (isDemoEmail(user.email)) {
        throw new ResetPasswordRejectedError(400, "This reset link is invalid or has expired");
      }

      const localLoginMode = getOidcConfig().localLoginMode;
      if (!isLocalLoginAllowed(localLoginMode, user.role)) {
        // Reset and invite completion can issue a local session, so the same
        // policy as /login applies. Throw to roll back token consumption;
        // returning a denial here would commit it and burn the reset link.
        throw new ResetPasswordRejectedError(403, "Use company SSO to sign in.");
      }

      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: false })
        .where(eq(users.id, userId));
      // A pending MFA login started with the old password dies with it.
      await invalidateMfaChallenges(userId, tx as unknown as SqlExecutor);
      await tx.delete(sessions).where(eq(sessions.userId, userId));

      // The reset link proves only email access. Issue a session only where
      // /login would issue one from the password alone: no enrolled passkey,
      // and not the break_glass emergency account (which must hold one).
      // Otherwise the new password and the consumed link still commit, and
      // the user signs in through /login and its second factor.
      const passkeys = await listPasskeys(userId, tx as unknown as SqlExecutor);
      const signInReason = passkeys.length > 0
        ? "second_factor_required"
        : localLoginMode === "break_glass" && user.role === "super_user"
          ? "break_glass_mfa_missing"
          : null;
      if (signInReason) {
        return { signInRequired: true as const, reason: signInReason, user };
      }

      const newToken = generateToken();
      const newTokenHash = hashToken(newToken);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await tx
        .insert(sessions)
        .values({ userId, tokenHash: newTokenHash, expiresAt });
      return {
        signInRequired: false as const,
        sessionToken: newToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          programId: user.programId ?? null,
          name: user.name,
          mustResetPassword: false
        }
      };
    });

    if (result.signInRequired) {
      const { user } = result;
      recordSecurityEventBestEffort({
        action: "auth.password_reset.sign_in_required",
        outcome: "success",
        actor: { id: user.id, email: user.email, role: user.role },
        programId: user.programId,
        resourceType: "user",
        resourceId: user.id,
        sourceIp: clientIpFrom(req),
        details: { authMethod: "local", reason: result.reason }
      });
      res.json({ passwordReset: true, signInRequired: true });
      return;
    }

    setSessionCookie(res, result.sessionToken);
    res.json({ user: result.user });
  } catch (err) {
    if (err instanceof ResetPasswordRejectedError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});
