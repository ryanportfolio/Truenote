import { Router } from "express";
import { requireAuth, authedUser } from "../middleware/current-user.js";

export const meRouter = Router();

/**
 * Returns the authenticated user. Unauthenticated clients get 401 (via
 * requireAuth) so the frontend can branch on that for "show login page"
 * rather than parse the body. `mustResetPassword` lets the frontend
 * redirect to the change-password screen when needed.
 */
meRouter.get("/", requireAuth, (req, res) => {
  const user = authedUser(req);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      programId: user.programId,
      name: user.name,
      mustResetPassword: user.mustResetPassword
    }
  });
});
