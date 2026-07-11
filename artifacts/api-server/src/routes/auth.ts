import { Router } from "express";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { passwordResetTokens, sessions, users } from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/auth/passwords.js";
import {
  createSession,
  deleteSessionByToken,
  generateToken,
  hashToken,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS
} from "../lib/auth/sessions.js";
import {
  createResetToken,
  hashResetToken,
  lookupResetTokenUserId
} from "../lib/auth/password-reset.js";
import {
  clientIpFrom,
  forgotPasswordEmailLimiter,
  forgotPasswordIpLimiter
} from "../lib/auth/rate-limit.js";
import {
  authedUser,
  DEMO_WRITE_BLOCKED_MESSAGE,
  requireAuth
} from "../middleware/current-user.js";
import { isDemoEmail } from "../lib/auth/demo-accounts.js";
import { getMinPasswordLength } from "../lib/config.js";
import { getEmailSender } from "../lib/email/sender.js";
import { resolveAppBaseUrl } from "../lib/email/links.js";
import { renderResetEmail } from "../lib/email/templates.js";

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
 * Apply the session cookie to the response. httpOnly + sameSite=lax give us
 * the standard CSRF posture without the complexity of a separate CSRF
 * token; the `secure` flag flips on in production so the cookie won't be
 * sent over plain HTTP. `path: /` is intentional — the API and the static
 * SPA share an origin and both need to see the cookie.
 *
 * `maxAge` is in MILLISECONDS for Express's res.cookie, matching the
 * session's DB expiry. If we ever introduce sliding sessions, this must
 * be refreshed on each request (today it's set once at login).
 */
function setSessionCookie(
  res: import("express").Response,
  token: string
): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_DURATION_MS,
    path: "/"
  });
}

function clearSessionCookie(res: import("express").Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

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
 * user-deactivated) tripped the rejection — a hostile script can't
 * enumerate accounts from the response shape.
 */
authRouter.post("/login", async (req, res, next) => {
  try {
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
        mustResetPassword: users.mustResetPassword
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    const row = rows[0];
    if (!row || !row.isActive) {
      // Dummy verify against a cached random-password hash so the timing
      // of "email not found / user deactivated" matches the "wrong
      // password" branch. See getDummyHash() for rationale.
      await verifyPassword(password, await getDummyHash());
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const ok = await verifyPassword(password, row.passwordHash);
    if (!ok) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    const { token } = await createSession(row.id);
    setSessionCookie(res, token);

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

/**
 * Change own password. Required for first-login users (`must_reset_password
 * = true`) — but ALSO callable by any authenticated user to rotate their
 * password voluntarily.
 *
 * Side effect: every existing session for this user is deleted, including
 * the one they're using right now. We immediately issue a fresh session so
 * the actor doesn't get logged out by their own password change. Stolen
 * cookies on the old password are dead instantly.
 */
authRouter.post("/change-password", requireAuth, async (req, res, next) => {
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

    // Password change is one ATOMIC transaction:
    //   (1) update the password hash + clear must_reset_password
    //   (2) delete every existing session (including this one)
    //   (3) insert the replacement session
    //
    // Without the transaction, a transient DB failure between (1) and (2)
    // would leave the password new but the OLD sessions — including any
    // stolen cookies — still valid. The whole point of revoke-then-reissue
    // is the security contract "stolen cookies on the old password are
    // dead instantly"; that contract requires all-or-nothing.
    const newToken = await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: false })
        .where(eq(users.id, user.id));
      await tx.delete(sessions).where(eq(sessions.userId, user.id));
      const token = generateToken();
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await tx
        .insert(sessions)
        .values({ userId: user.id, tokenHash, expiresAt });
      return token;
    });
    setSessionCookie(res, newToken);

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
      }
    })();
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/reset-password — consume a reset link, set new
 * password, log the user in.
 *
 * Atomic transaction:
 *   (1) re-verify the token is unused + unexpired (under the row
 *       lock — the lookup above the transaction is racy)
 *   (2) mark token used
 *   (3) update password_hash + clear must_reset_password
 *   (4) delete every session for this user
 *   (5) issue a fresh session
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
      if (!consumedRow) return null;

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
      if (!user || !user.isActive) return null;

      // Belt-and-suspenders: forgot-password never issues tokens for
      // demo emails, but a token minted before the account became a
      // demo account (or via a future code path) must still not rotate
      // a published demo password. Generic invalid-link response — no
      // need to advertise the account's demo status here.
      if (isDemoEmail(user.email)) return null;

      await tx
        .update(users)
        .set({ passwordHash, mustResetPassword: false })
        .where(eq(users.id, userId));
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      const newToken = generateToken();
      const newTokenHash = hashToken(newToken);
      const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
      await tx
        .insert(sessions)
        .values({ userId, tokenHash: newTokenHash, expiresAt });
      return {
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

    if (!result) {
      res
        .status(400)
        .json({ error: "This reset link is invalid or has expired" });
      return;
    }

    setSessionCookie(res, result.sessionToken);
    res.json({ user: result.user });
  } catch (err) {
    next(err);
  }
});
