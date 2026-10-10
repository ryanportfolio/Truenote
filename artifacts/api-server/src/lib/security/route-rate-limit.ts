import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import { clientIpFrom } from "../auth/rate-limit.js";

/**
 * Per-user request limits for authenticated API routes.
 * They run after requireAuth, so every request has a user and the counter is
 * keyed by user id (IP checks don't apply). In-memory, like the auth
 * limiter: production runs one `web` replica (.claude/reference/deployment.md).
 * The limits sit well above what a person clicking through the UI produces;
 * they stop a script or a stuck client from hammering the database.
 * The exception is mfaLoginIpLimit at the end: its routes run before
 * sign-in, so it counts per client IP.
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
