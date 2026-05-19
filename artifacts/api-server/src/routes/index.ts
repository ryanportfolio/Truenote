import type { Express } from "express";
import { healthRouter } from "./health.js";
import { askRouter } from "./ask.js";
import { documentsRouter } from "./documents.js";
import { meRouter } from "./me.js";

export function registerRoutes(app: Express): void {
  app.use("/health", healthRouter);
  app.use("/api/me", meRouter);
  app.use("/api/documents", documentsRouter);
  app.use("/api", askRouter);
}
