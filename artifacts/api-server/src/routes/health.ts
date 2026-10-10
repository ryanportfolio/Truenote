import { Router } from "express";
import { cachedReadiness } from "../lib/monitoring/heartbeat.js";

export const healthRouter = Router();

// Liveness for Railway's deploy healthcheck: answers while the process runs.
// It stays static so a database or worker outage does not make Railway
// restart a healthy web process or block a deploy.
healthRouter.get("/", (_req, res) => {
  res.json({ ok: true });
});

// Readiness for the external uptime monitor: the database answers and the
// worker wrote a heartbeat within the last three minutes. 503 otherwise.
healthRouter.get("/ready", async (_req, res) => {
  const readiness = await cachedReadiness();
  res.setHeader("Cache-Control", "no-store");
  res.status(readiness.ok ? 200 : 503).json(readiness);
});
