import { Router } from "express";
import { getMinPasswordLength } from "../lib/config.js";

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
    emailResetAvailable: isEmailResetAvailable()
  };
  res.json(payload);
});
