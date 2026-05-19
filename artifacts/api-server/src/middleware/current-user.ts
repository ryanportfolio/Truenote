import type { NextFunction, Request, Response } from "express";
import { currentUser } from "../lib/auth/current-user.js";

/**
 * Attach the stub current user to every request. Phase 2 replaces this with
 * real session-based auth; keeping the same `req.user` shape so route handlers
 * don't need to change.
 */
export async function attachCurrentUser(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    req.user = await currentUser();
    next();
  } catch (err) {
    next(err);
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
