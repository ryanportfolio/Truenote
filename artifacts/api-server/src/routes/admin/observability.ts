import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import {
  normalizePipelineTiming,
  summarizeProviderTimings,
  summarizeStageTimings,
  timingPercentile,
  type PipelineTimingBreakdown
} from "../../lib/observability/pipeline-timing.js";
import { isMissingTimingColumn } from "../../lib/observability/pipeline-timing-store.js";
import { getSiemDeliveryHealth } from "../../lib/security/siem-outbox.js";
import {
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";

export const observabilityRouter = Router();

observabilityRouter.use(requireAuth, requireFreshPassword, requireSuperUser);

const Query = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  limit: z.coerce.number().int().min(1).max(250).default(100)
});

const MAX_AGGREGATE_SAMPLES = 2_000;

observabilityRouter.get("/security-audit", async (_req, res, next) => {
  try {
    res.json(await getSiemDeliveryHealth());
  } catch (error) {
    next(error);
  }
});

interface TimingRow {
  id: string;
  question: string;
  program_name: string | null;
  refused: boolean | null;
  created_at: Date | string | null;
  timing_breakdown: unknown;
}

function emptyResponse(hours: number, storageReady: boolean) {
  return {
    storageReady,
    windowHours: hours,
    sampleCount: 0,
    sampleTruncated: false,
    summary: {
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      refusalRatePct: 0
    },
    stages: [],
    providers: [],
    recent: []
  };
}

/**
 * Cross-program live pipeline telemetry. This deliberately ignores the
 * selected-program header: only a super user may enter, and the purpose is to
 * spot system-wide provider or stage degradation.
 */
observabilityRouter.get("/", async (req, res, next) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid observability window" });
    return;
  }
  const { hours, limit } = parsed.data;

  try {
    const result = await db.execute(sql`
      SELECT q.id,
             q.question,
             p.name AS program_name,
             q.refused,
             q.created_at,
             q.timing_breakdown
      FROM query_log q
      LEFT JOIN programs p ON p.id = q.program_id
      WHERE q.created_at >= NOW() - (${hours} * INTERVAL '1 hour')
        AND q.timing_breakdown IS NOT NULL
      ORDER BY q.created_at DESC
      LIMIT ${MAX_AGGREGATE_SAMPLES + 1}
    `);
    const rawRows = result.rows as unknown as TimingRow[];
    const sampleTruncated = rawRows.length > MAX_AGGREGATE_SAMPLES;
    const rows = rawRows.slice(0, MAX_AGGREGATE_SAMPLES).flatMap((row) => {
      const timing = normalizePipelineTiming(row.timing_breakdown);
      return timing ? [{ row, timing }] : [];
    });
    if (rows.length === 0) {
      res.json(emptyResponse(hours, true));
      return;
    }

    const timings = rows.map(({ timing }) => timing);
    const total = timings.reduce((sum, timing) => sum + timing.totalMs, 0);
    const refused = rows.filter(({ row }) => row.refused === true).length;

    res.json({
      storageReady: true,
      windowHours: hours,
      sampleCount: timings.length,
      sampleTruncated,
      summary: {
        meanMs: Math.round(total / timings.length),
        p50Ms: timingPercentile(timings, 50),
        p95Ms: timingPercentile(timings, 95),
        refusalRatePct: Math.round((refused / rows.length) * 1000) / 10
      },
      stages: summarizeStageTimings(timings),
      providers: summarizeProviderTimings(timings),
      recent: rows.slice(0, limit).map(({ row, timing }) => ({
        id: row.id,
        question: row.question.slice(0, 160),
        programName: row.program_name ?? "Unknown program",
        refused: row.refused === true,
        createdAt:
          row.created_at instanceof Date
            ? row.created_at.toISOString()
            : row.created_at,
        timing
      }))
    });
  } catch (error) {
    if (isMissingTimingColumn(error)) {
      res.json(emptyResponse(hours, false));
      return;
    }
    next(error);
  }
});

export type ObservabilityTiming = PipelineTimingBreakdown;
