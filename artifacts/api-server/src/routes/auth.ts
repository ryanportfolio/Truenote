import { Router } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../lib/db-client.js";
import { sessions, users } from "@workspace/db/schema";
import { hashPassword, verifyPassword } from "../lib/auth/passwords.js";
import {
  createSession,
  deleteSessionByToken,
  generateToken,
  hashToken,
  SESSION_COOKIE_NAME,
  SESSION_DURATION_MS
} from "../lib/auth/sessions.js";
import { authedUser, requireAuth } from "../middleware/current-user.js";
import { getMinPasswordLength } from "../lib/config.js";

export const authRouter = Router();

const LoginBody = z.object({
  email: z.string().email().max(254),
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
