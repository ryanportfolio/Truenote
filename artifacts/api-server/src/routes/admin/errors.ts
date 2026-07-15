import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { isMissingErrorLogTable } from "../../lib/observability/error-log.js";
import { appendSecurityEvent } from "../../lib/security/audit.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";

export const errorsRouter = Router();

errorsRouter.use(
  requireAuth,
  requireFreshPassword,
  requireSuperUser,
  blockDemoWrites
);

const Query = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 30).default(24),
  limit: z.coerce.number().int().min(1).max(250).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  severity: z.enum(["all", "warning", "error", "fatal"]).default("all"),
  source: z.string().trim().max(80).optional()
});

interface ErrorRow {
  id: string;
  occurred_at: Date | string;
  severity: "warning" | "error" | "fatal";
  source: string;
  operation: string;
  message: string;
  name: string | null;
  stack: string | null;
  code: string | null;
  status: number | null;
  provider: string | null;
  model: string | null;
  route_id: string | null;
  request_id: string | null;
  correlation_id: string | null;
  method: string | null;
  path: string | null;
  user_id: string | null;
  program_id: string | null;
  query_log_id: string | null;
  details: unknown;
}

function emptyResponse(hours: number, storageReady: boolean) {
  return {
    storageReady,
    windowHours: hours,
    total: 0,
    hasMore: false,
    counts: { warning: 0, error: 0, fatal: 0 },
    sources: [],
    items: []
  };
}

errorsRouter.get("/", async (req, res, next) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid error-log filters" });
    return;
  }
  const { hours, limit, offset, severity, source } = parsed.data;
  const conditions = [
    sql`occurred_at >= NOW() - (${hours} * INTERVAL '1 hour')`
  ];
  if (severity !== "all") conditions.push(sql`severity = ${severity}`);
  if (source) conditions.push(sql`source = ${source}`);
  const where = sql.join(conditions, sql` AND `);

  try {
    const [itemsResult, summaryResult, sourcesResult] = await Promise.all([
      db.execute(sql`
        SELECT id, occurred_at, severity, source, operation, message, name,
               stack, code, status, provider, model, route_id, request_id,
               correlation_id, method, path, user_id, program_id, query_log_id,
               details
        FROM error_log
        WHERE ${where}
        ORDER BY occurred_at DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `),
      db.execute(sql`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE severity = 'warning')::int AS warning,
               COUNT(*) FILTER (WHERE severity = 'error')::int AS error,
               COUNT(*) FILTER (WHERE severity = 'fatal')::int AS fatal
        FROM error_log
        WHERE ${where}
      `),
      db.execute(sql`
        SELECT DISTINCT source
        FROM error_log
        WHERE occurred_at >= NOW() - (${hours} * INTERVAL '1 hour')
        ORDER BY source
      `)
    ]);
    const summary = summaryResult.rows[0] as
      | { total: number; warning: number; error: number; fatal: number }
      | undefined;
    const total = summary?.total ?? 0;
    const rows = itemsResult.rows as unknown as ErrorRow[];
    res.json({
      storageReady: true,
      windowHours: hours,
      total,
      hasMore: offset + rows.length < total,
      counts: {
        warning: summary?.warning ?? 0,
        error: summary?.error ?? 0,
        fatal: summary?.fatal ?? 0
      },
      sources: sourcesResult.rows.flatMap((row) => {
        const value = (row as { source?: unknown }).source;
        return typeof value === "string" ? [value] : [];
      }),
      items: rows.map((row) => ({
        id: row.id,
        occurredAt:
          row.occurred_at instanceof Date
            ? row.occurred_at.toISOString()
            : row.occurred_at,
        severity: row.severity,
        source: row.source,
        operation: row.operation,
        message: row.message,
        name: row.name,
        stack: row.stack,
        code: row.code,
        status: row.status,
        provider: row.provider,
        model: row.model,
        routeId: row.route_id,
        requestId: row.request_id,
        correlationId: row.correlation_id,
        method: row.method,
        path: row.path,
        userId: row.user_id,
        programId: row.program_id,
        queryLogId: row.query_log_id,
        details: row.details
      }))
    });
  } catch (error) {
    if (isMissingErrorLogTable(error)) {
      res.json(emptyResponse(hours, false));
      return;
    }
    next(error);
  }
});

errorsRouter.delete("/", async (req, res, next) => {
  try {
    const user = authedUser(req);
    const deletedCount = await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        WITH deleted AS (
          DELETE FROM error_log
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted_count
        FROM deleted
      `);
      const count = Number(
        (result.rows[0] as { deleted_count?: unknown } | undefined)?.deleted_count ?? 0
      );
      await appendSecurityEvent(
        {
          action: "error_log.clear",
          outcome: "success",
          actor: user,
          resourceType: "error_log",
          details: { deletedCount: count }
        },
        tx as unknown as Parameters<typeof appendSecurityEvent>[1]
      );
      return count;
    });
    res.json({ deletedCount });
  } catch (error) {
    if (isMissingErrorLogTable(error)) {
      res.status(503).json({ error: "Error-log storage is not installed yet" });
      return;
    }
    next(error);
  }
});
