import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import type { PipelineTimingBreakdown } from "./pipeline-timing.js";

function isMissingTimingColumn(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === "42703"
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return false;
}

/**
 * Best-effort telemetry export. Missing DDL must never break an answer. The
 * legacy latency column is updated in the same write so it reflects the full
 * observed request rather than only model completion.
 */
export async function savePipelineTiming(
  queryLogId: string,
  timing: PipelineTimingBreakdown
): Promise<boolean> {
  try {
    const value = JSON.stringify(timing);
    const result = await db.execute(sql`
      UPDATE query_log
      SET latency_ms = ${timing.totalMs},
          timing_breakdown = ${value}::jsonb
      WHERE id = ${queryLogId}::uuid
      RETURNING id
    `);
    return result.rows.length > 0;
  } catch (error) {
    if (isMissingTimingColumn(error)) {
      // Preserve the improved full-request latency even while code and DDL are
      // temporarily out of order during deployment.
      try {
        await db.execute(sql`
          UPDATE query_log
          SET latency_ms = ${timing.totalMs}
          WHERE id = ${queryLogId}::uuid
        `);
      } catch {
        // Best effort by contract; the original query_log insert still exists.
      }
    } else {
      console.warn(
        "[observability] failed to persist pipeline timing:",
        error instanceof Error ? error.message : error
      );
    }
    return false;
  }
}

export { isMissingTimingColumn };
