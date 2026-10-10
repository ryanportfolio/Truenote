import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { clientIpFrom } from "../auth/rate-limit.js";

/**
 * Per-user request limits for authenticated API routes.
 * They run after requireAuth, so every request has a user and the counter is
 * keyed by user id (IP checks don't apply). In-memory, like the auth
 * limiter: production runs one `web` replica (.claude/reference/deployment.md).
 * The limits sit well above what a person clicking through the UI produces;
 * they stop a script or a stuck client from hammering the database.
 * The exceptions are the sign-in limiters at the end (loginPasswordIpLimit,
 * oidcIpLimit, mfaLoginIpLimit): their routes run before sign-in, so they
 * count per client IP.
 */
function perUserLimit(limit: number, windowMs: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.id ?? "anonymous",
    validate: false,
    handler: (_req, res) => {
      res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
    }
  });
}

/** Pins, notes, colors and label names: 120 a minute per user. */
export const personalLibraryWriteLimit = perUserLimit(120, 60_000);

/** Manager library edits (folders, tags, team shortcuts): 120 a minute per user. */
export const libraryOrganizeLimit = perUserLimit(120, 60_000);

/** Ask page example question edits: 30 a minute per user. */
export const askExamplesWriteLimit = perUserLimit(30, 60_000);

/** Team assignment moves: 30 a minute per user. */
export const teamsWriteLimit = perUserLimit(30, 60_000);

/** Source usage analytics reads (heavier queries): 60 a minute per user. */
export const sourceUsageReadLimit = perUserLimit(60, 60_000);

/** Teams page reads: 60 a minute per user. */
export const teamsReadLimit = perUserLimit(60, 60_000);

/** User administration writes (create, import, edit, delete): 30 a minute per user. */
export const userAdminWriteLimit = perUserLimit(30, 60_000);

/** Security page setting changes (demo limits, malware scanning): 30 a minute per user. */
export const securitySettingWriteLimit = perUserLimit(30, 60_000);

/** Current-user lookup, called on every page load: 120 a minute per user. */
export const currentUserReadLimit = perUserLimit(120, 60_000);

/** Ask history list and transcript reads: 120 a minute per user. */
export const sessionHistoryReadLimit = perUserLimit(120, 60_000);

/** Answer feedback and missing-content flags: 60 a minute per user. */
export const answerFeedbackWriteLimit = perUserLimit(60, 60_000);

/** Document list and version preview reads: 120 a minute per user. */
export const documentReadLimit = perUserLimit(120, 60_000);

/** Document lifecycle changes (source, approve, reject, revoke, retire, purge): 30 a minute per user. */
export const documentLifecycleWriteLimit = perUserLimit(30, 60_000);

/** Admin list reads (programs, queries, users, knowledge gaps): 60 a minute per user. */
export const adminReadLimit = perUserLimit(60, 60_000);

/** Admin configuration writes (model routing, error-log deletion): 30 a minute per user. */
export const adminConfigWriteLimit = perUserLimit(30, 60_000);

/** Evidence harness reads (receipts, controls, failures): 60 a minute per user. */
export const evidenceReadLimit = perUserLimit(60, 60_000);

/** Evidence harness writes (known-gap links, manual runs): 10 a minute per user. */
export const evidenceWriteLimit = perUserLimit(10, 60_000);

/** Compliance document reads (list and documents): 60 a minute per user. */
export const complianceReadLimit = perUserLimit(60, 60_000);

/** Emergency sign-in card (passkeys, recovery codes, status): 30 a minute per user. */
export const mfaManageLimit = perUserLimit(30, 60_000);

/**
 * Password login (POST /api/auth/login), keyed by client IP (clientIpFrom).
 * 2000 per 10 minutes, the same budget as the in-handler loginIpLimiter,
 * which stays in place; this limiter is the one CodeQL recognizes. It has
 * its own counter, separate from mfaLoginIpLimit, because one sign-in uses
 * both routes. The per-account lockout bounds guessing on one account. The
 * 429 body is the in-handler limiter's, so a refusal says nothing about any
 * account.
 */
export const loginPasswordIpLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 2000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIpFrom(req),
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }
});

/**
 * Company SSO (GET /api/auth/oidc/start and /callback), keyed by client IP.
 * 2000 per 10 minutes, shared by both routes: a call center behind one
 * address signs in hundreds of users at shift start, two requests each.
 * Both routes are browser navigations, so a refusal answers the way their
 * failure path does (redirectWithError in routes/oidc.ts): a 302 to
 * /login?sso_error=1, where the login page shows its generic SSO error. A
 * JSON 429 would leave the user on a raw error page. The redirect carries
 * nothing about any account. A refused callback leaves the state cookie in
 * place; it expires after 10 minutes and the next start replaces it.
 */
export const oidcIpLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 2000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIpFrom(req),
  validate: false,
  handler: (_req, res) => {
    res.redirect(302, "/login?sso_error=1");
  }
});

/**
 * Second login step (POST /api/auth/mfa/passkey and /recovery-code), which
 * runs before any session exists, so it is keyed by client IP the way
 * loginIpLimiter keys it (clientIpFrom). 2000 per 10 minutes, the same as
 * loginIpLimiter, so a call center behind one shared address is never
 * blocked; the per-account lockout bounds guessing on a single account.
 * The two routes share the budget.
 */
export const mfaLoginIpLimit = rateLimit({
  windowMs: 10 * 60_000,
  limit: 2000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIpFrom(req),
  validate: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many login attempts. Try again in a few minutes." });
  }
});
