import { Router } from "express";
import { getMinPasswordLength } from "../lib/config.js";
import {
  getDemoAccounts,
  toPublicDemoAccounts,
  type PublicDemoAccount
} from "../lib/auth/demo-accounts.js";
import { getOidcConfig, type LocalLoginMode } from "../lib/auth/oidc.js";

export const configRouter = Router();

export interface AppConfig {
  /**
   * Minimum length the change-password form should enforce. Server is
   * the source of truth (the zod schema rejects shorter passwords); the
   * client mirrors it for UX so the user isn't surprised by a 400.
   */
  minPasswordLength: number;
  /**
   * True when the api-server has a real email transport configured
   * (RESEND_API_KEY + RESEND_FROM_EMAIL both set). When false, the
   * forgot-password endpoint still 204s but the token only lands in
   * the api-server's stdout — clicking "Forgot password?" in that
   * state would silently fail from the user's perspective. The SPA
   * uses this flag to either hide the link or surface a "contact
   * your admin to reset" message.
   *
   * Whether email is configured is not a secret — anyone can probe
   * it by submitting a reset request and observing no email arrives.
   * Exposing the boolean just makes the UX honest.
   */
  emailResetAvailable: boolean;
  oidcEnabled: boolean;
  localLoginMode: LocalLoginMode;
  /**
   * Present ONLY when DEMO_LOGIN_ACCOUNTS is set (demo deployments).
   * This is the one sanctioned exception to "strictly non-secret":
   * it deliberately publishes working demo credentials so the login
   * page can pre-fill them — that IS the feature. The parse schema
   * caps demo roles at "manager", so these credentials can never
   * grant user management or cross-program access. Never set the
   * env var on a deployment holding real content.
   */
  demoAccounts?: PublicDemoAccount[];
}

function isEmailResetAvailable(): boolean {
  return Boolean(
    process.env.RESEND_API_KEY?.trim() &&
      process.env.RESEND_FROM_EMAIL?.trim()
  );
}

/**
 * Public config endpoint — no auth required. The values here are not
 * secrets (clients can read MIN_PASSWORD_LENGTH server-side from any
 * password-attempt response anyway, and exposing the floor doesn't
 * weaken auth). Keep it strictly non-secret as it grows.
 */
configRouter.get("/", (_req, res) => {
  const payload: AppConfig = {
    minPasswordLength: getMinPasswordLength(),
    emailResetAvailable: isEmailResetAvailable(),
    oidcEnabled: getOidcConfig().enabled,
    localLoginMode: getOidcConfig().localLoginMode
  };
  const demoAccounts = getDemoAccounts();
  if (demoAccounts) {
    payload.demoAccounts = toPublicDemoAccounts(demoAccounts);
  }
  res.json(payload);
});
