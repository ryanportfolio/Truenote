import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";

/**
 * Per-user request limits for the source library and Source usage routes.
 * They run after requireAuth, so every request has a user and the counter is
 * keyed by user id (IP checks don't apply). In-memory, like the auth
 * limiter: production runs one `web` replica (.claude/reference/deployment.md).
 * The limits sit well above what a person clicking through the UI produces;
 * they stop a script or a stuck client from hammering the database.
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

/** Security page setting changes (the demo-limits switch): 30 a minute per user. */
export const securitySettingWriteLimit = perUserLimit(30, 60_000);

/** Compliance document reads (list and documents): 60 a minute per user. */
export const complianceReadLimit = perUserLimit(60, 60_000);
