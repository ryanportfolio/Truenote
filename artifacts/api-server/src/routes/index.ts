import type { Express } from "express";
import { healthRouter } from "./health.js";
import { askRouter } from "./ask.js";
import { authRouter } from "./auth.js";
import { documentsRouter } from "./documents.js";
import { meRouter } from "./me.js";
import { programsRouter } from "./admin/programs.js";

export function registerRoutes(app: Express): void {
  app.use("/health", healthRouter);
  // Auth routes (login / logout / change-password) are mounted before
  // everything else so they remain reachable even if a downstream route's
  // requireAuth/requireFreshPassword guard would reject the actor.
  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/admin/programs", programsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api", askRouter);
}
