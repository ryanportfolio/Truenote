import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../lib/db-client.js";

/**
 * Public liveness signal for the evidence harness: when the last receipt of a
 * worker run (run_id set: a scheduled or manually triggered run) was
 * recorded, nothing else. Attestation uploads, monthly summaries and operator
 * receipts carry no run id and do not count, so they cannot hide a stopped
 * worker. The scheduled evidence-watch GitHub Action reads it from outside
 * Railway and fails when run receipts stop arriving, which the harness
 * cannot report about itself. Cached for a minute so the endpoint
 * costs one small query per minute at most.
 */
export const evidenceHeartbeatRouter = Router();

export const HEARTBEAT_STALE_HOURS = 26;
const CACHE_MS = 60_000;

let cached: { at: number; lastReceiptAt: string | null } | undefined;

evidenceHeartbeatRouter.get("/", async (_req, res) => {
  try {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const result = await db.execute(sql`
        SELECT max(recorded_at_text) AS last FROM evidence_receipts WHERE run_id IS NOT NULL
      `);
      cached = {
        at: Date.now(),
        lastReceiptAt: ((result.rows[0] as { last?: string | null } | undefined)?.last) ?? null
      };
    }
    const ageHours = cached.lastReceiptAt
      ? (Date.now() - Date.parse(cached.lastReceiptAt)) / 3_600_000
      : null;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      lastReceiptAt: cached.lastReceiptAt,
      ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      staleAfterHours: HEARTBEAT_STALE_HOURS,
      stale: ageHours === null || ageHours > HEARTBEAT_STALE_HOURS
    });
  } catch {
    res.setHeader("Cache-Control", "no-store");
    res.status(503).json({ lastReceiptAt: null, ageHours: null, staleAfterHours: HEARTBEAT_STALE_HOURS, stale: true });
  }
});
