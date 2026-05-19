import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@workspace/db/schema";

declare global {
  // eslint-disable-next-line no-var
  var __ragPgPool: Pool | undefined;
}

/**
 * One Pool per process. node-postgres' Pool() constructor with no connection
 * string doesn't throw — it falls back to PGHOST/PGUSER/etc. env vars. The
 * pool only errors at query time if config is bad, which is the behavior
 * we want: module import never throws, but a real query fails loudly.
 *
 * pg-boss (lib/ingestion/queue.ts) connects via its own DATABASE_URL config
 * but ends up against the same Postgres, so they coexist.
 */
function getPool(): Pool {
  if (!globalThis.__ragPgPool) {
    globalThis.__ragPgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10
    });
  }
  return globalThis.__ragPgPool;
}

export const db = drizzle(getPool(), { schema });

/**
 * Drain and dispose the pg Pool. Call from worker shutdown handlers — without
 * this, Postgres holds onto idle connection slots until tcp_keepalives_idle
 * fires (expensive on Neon).
 */
export async function closePool(): Promise<void> {
  const existing = globalThis.__ragPgPool;
  if (!existing) return;
  globalThis.__ragPgPool = undefined;
  await existing.end();
}

export { schema };
export type DbSchema = typeof schema;
