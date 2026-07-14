import type { Express } from "express";
import { healthRouter } from "./health.js";
import { askRouter } from "./ask.js";
import { authRouter } from "./auth.js";
import { configRouter } from "./config.js";
import { documentsRouter } from "./documents.js";
import { kbRouter } from "./kb.js";
import { sessionsRouter } from "./sessions.js";
import { meRouter } from "./me.js";
import { programsRouter } from "./admin/programs.js";
import { queriesRouter } from "./admin/queries.js";
import { usersRouter } from "./admin/users.js";
import { insightsRouter } from "./admin/insights.js";
import { modelRoutingRouter } from "./admin/model-routing.js";
import { evaluationsRouter } from "./admin/evaluations.js";
import { observabilityRouter } from "./admin/observability.js";
import { errorsRouter } from "./admin/errors.js";
import { oidcRouter } from "./oidc.js";

export function registerRoutes(app: Express): void {
  app.use("/health", healthRouter);
  // Auth routes (login / logout / change-password) are mounted before
  // everything else so they remain reachable even if a downstream route's
  // requireAuth/requireFreshPassword guard would reject the actor.
  app.use("/api/auth", authRouter);
  app.use("/api/auth/oidc", oidcRouter);
  // Public, non-secret config (e.g. minPasswordLength). The change-
  // password page calls this before mount to mirror the server's
  // floor in the UI.
  app.use("/api/config", configRouter);
  app.use("/api/me", meRouter);
  app.use("/api/admin/programs", programsRouter);
  app.use("/api/admin/queries", queriesRouter);
  app.use("/api/admin/users", usersRouter);
  app.use("/api/admin/insights", insightsRouter);
  app.use("/api/admin/model-routing", modelRoutingRouter);
  app.use("/api/admin/evaluations", evaluationsRouter);
  app.use("/api/admin/observability", observabilityRouter);
  app.use("/api/admin/errors", errorsRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api/kb", kbRouter);
  app.use("/api/sessions", sessionsRouter);
  app.use("/api", askRouter);
}
