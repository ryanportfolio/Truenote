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
}

/**
 * Public config endpoint — no auth required. The values here are not
 * secrets (clients can read MIN_PASSWORD_LENGTH server-side from any
 * password-attempt response anyway, and exposing the floor doesn't
 * weaken auth). Keep it strictly non-secret as it grows.
 */
configRouter.get("/", (_req, res) => {
  const payload: AppConfig = {
    minPasswordLength: getMinPasswordLength()
  };
  res.json(payload);
});
