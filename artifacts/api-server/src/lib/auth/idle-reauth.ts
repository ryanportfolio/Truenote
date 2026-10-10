import type { Request, Response } from "express";
import { getSsoSessionMaxMs } from "./session-policy.js";

/**
 * Re-authentication after an SSO idle expiry (PCI DSS 8.2.8, PCI SSC FAQ 1147).
 *
 * When the idle limit ends an oidc session, Entra would usually sign the
 * user in again silently, so a person at an unattended, unlocked browser
 * would get back in without proving who they are. The idle expiry sets
 * this marker cookie; GET /api/auth/oidc/start then sends prompt=login and
 * the callback requires an `auth_time` from after the start.
 *
 * The marker is a plain value, not signed: forging one can only make a
 * sign-in stricter. Its weakness is removal; someone who deletes this one
 * cookie from the browser before signing in gets a silent sign-in. The
 * lifetime equals SSO_SESSION_MAX_HOURS because the SPA polls in the
 * background, so the expiry is usually detected while the user is away
 * and the next sign-in can come hours later.
 */
export const IDLE_REAUTH_COOKIE = "truenote_oidc_reauth";
const COOKIE_PATH = "/api/auth/oidc";

export function markIdleReauth(res: Response): void {
  // The current request may itself be /oidc/start, whose cookies were
  // parsed before this marker existed.
  res.locals.oidcReauthRequired = true;
  res.cookie(IDLE_REAUTH_COOKIE, "1", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: getSsoSessionMaxMs(),
    path: COOKIE_PATH
  });
}

export function isIdleReauthRequired(req: Request, res: Response): boolean {
  return (
    res.locals?.oidcReauthRequired === true ||
    typeof req.cookies?.[IDLE_REAUTH_COOKIE] === "string"
  );
}

export function clearIdleReauth(res: Response): void {
  res.clearCookie(IDLE_REAUTH_COOKIE, { path: COOKIE_PATH });
}
