import { Router } from "express";

export const meRouter = Router();

meRouter.get("/", (req, res) => {
  // Returns the auth-middleware-attached current user. Phase 1 is a stub;
  // Phase 2 swaps the middleware to read a real session.
  res.json({ user: req.user });
});
