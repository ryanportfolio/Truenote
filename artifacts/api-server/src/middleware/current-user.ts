import type { NextFunction, Request, Response } from "express";
import {
  findSessionByToken,
  SESSION_COOKIE_NAME
} from "../lib/auth/sessions.js";
import {
  hasAtLeastRole,
  type CurrentUser,
  type UserRole
} from "../lib/auth/current-user.js";
import { isDemoEmail } from "../lib/auth/demo-accounts.js";

/**
 * App-level middleware. Resolves `req.user` from the session cookie if one
 * is present and valid, otherwise leaves `req.user` as `null`. Never
 * rejects the request — auth enforcement is a route-level concern via
 * `requireAuth` / `requireRole`. This split lets public endpoints (login,
 * health) sit on the same app without each opt-ing out.
 */
export async function attachCurrentUser(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token =
      typeof req.cookies?.[SESSION_COOKIE_NAME] === "string"
        ? req.cookies[SESSION_COOKIE_NAME]
        : undefined;
    const session = await findSessionByToken(token);
    req.user = session
      ? {
          id: session.id,
          email: session.email,
          role: session.role,
          programId: session.programId,
          name: session.name,
          mustResetPassword: session.mustResetPassword
        }
      : null;
    next();
  } catch (err) {
    // A DB hiccup during the session lookup must not 500 the whole request
    // — fall through as unauthenticated and let the route's guard 401.
    console.warn("[auth] session lookup failed:", err);
    req.user = null;
    next();
  }
}

/**
 * Narrowing helper. Routes that have gone through `requireAuth` are
 * guaranteed `req.user` is non-null; this turns that runtime guarantee
 * into a TS-typed value without scattering `!` non-null assertions.
 *
 * If you see this throw in practice, you're calling it on a route that
 * doesn't have `requireAuth` in its chain — fix the chain, not the call.
 */
export function authedUser(req: Request): CurrentUser {
  if (!req.user) {
    throw new Error(
      "authedUser called on a route without requireAuth in its chain"
    );
  }
  return req.user;
}

/** Route guard: 401 if there's no authenticated user. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

/**
 * Role-based guard factory. Requires the user be at least the specified
 * role per `ROLE_RANK` in current-user.ts. Use the named exports below for
 * the common cases; build ad-hoc combos with this builder.
 *
 * IMPORTANT: chain this AFTER `requireAuth`. If `req.user` is null this
 * sends 401 too (defensive), but the canonical pattern is `requireAuth,
 * requireRole(...)`.
 */
export function requireRole(minimum: UserRole) {
  return function (req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!hasAtLeastRole(req.user, minimum)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

/**
 * Convenience guards for the four canonical capability tiers. These read
 * cleanly in route declarations and discourage accidental tier drift —
 * `requireManagerOrAbove` is harder to typo than passing the string
 * `"manager"`.
 */
export const requireSuperUser = requireRole("super_user");
export const requireSeniorManagerOrAbove = requireRole("senior_manager");
export const requireManagerOrAbove = requireRole("manager");
export const requireCsrOrAbove = requireRole("csr");

/**
 * User-facing copy for every demo-write refusal. Kept as a single export
 * so the frontend can match on the exact string and the message never
 * drifts between routes.
 */
export const DEMO_WRITE_BLOCKED_MESSAGE = "Demo accounts can't do this";

/**
 * Demo-account write guard. Demo deployments publish working credentials
 * on /api/config, so a "logged-in manager" may be any anonymous visitor.
 * They get the full read experience (and /api/ask — that IS the demo),
 * but mutations that would degrade the shared demo for the next visitor
 * are refused: document upload/delete, user create/edit/reset,
 * program create.
 *
 * Method-based (anything but GET/HEAD/OPTIONS) so a new mutating route
 * added to a guarded router is blocked by default rather than forgotten.
 * Mount AFTER requireAuth on routers whose non-GET routes should be
 * demo-frozen; routers that must stay demo-usable (ask, sessions, personal
 * knowledge-base highlights) simply don't mount it.
 *
 * `ok: false` rides along for callers typed against the upload response
 * shape; everyone else reads `error`.
 */
export function blockDemoWrites(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (
    req.user &&
    req.method !== "GET" &&
    req.method !== "HEAD" &&
    req.method !== "OPTIONS" &&
    isDemoEmail(req.user.email)
  ) {
    res.status(403).json({
      ok: false,
      error: DEMO_WRITE_BLOCKED_MESSAGE,
      code: "demo_account"
    });
    return;
  }
  next();
}

/**
 * Forced-password-reset gate. The bootstrap super_user and any user
 * created by a manager land with `must_reset_password=true`. Until they
 * change their password, every request to a non-bootstrap endpoint should
 * 423 (Locked) so the frontend can route them to the change-password
 * page. Bypass exceptions: `/api/me`, `/api/auth/change-password`,
 * `/api/auth/logout` — these must work to complete the reset.
 *
 * This guard is mounted PER-ROUTE rather than app-wide so the bypass list
 * stays explicit in routes/index.ts. A future refactor could mount it on
 * a sub-app of guarded routes.
 */
export function requireFreshPassword(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.user.mustResetPassword) {
    res.status(423).json({ error: "Password reset required" });
    return;
  }
  next();
}
