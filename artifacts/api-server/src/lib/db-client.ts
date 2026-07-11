import { Pool, type PoolClient } from "pg";
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

/**
 * Hold a session-level advisory lock across a long worker operation. Returns
 * false when another process already owns the same key; crashes release the
 * connection/lock, so a pg-boss retry can safely resume.
 */
export async function withPgAdvisoryLock(
  key: string,
  work: () => Promise<void>
): Promise<boolean> {
  const client = await getPool().connect();
  return withPgAdvisoryLockClient(client, key, work);
}

/** @internal Exported so lock cleanup behavior can be verified without Postgres. */
export async function withPgAdvisoryLockClient(
  client: Pick<PoolClient, "query" | "release">,
  key: string,
  work: () => Promise<void>
): Promise<boolean> {
  let locked = false;
  let destroyClient = false;
  try {
    const result = await client
      .query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        [key]
      )
      .catch((error: unknown) => {
        // A failed session query leaves connection state uncertain. Never put
        // that client back in the pool where a hidden advisory lock could be
        // inherited by unrelated work.
        destroyClient = true;
        throw error;
      });
    locked = result.rows[0]?.locked === true;
    if (!locked) return false;
    await work();
    return true;
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
      } catch {
        // Destroying the physical session releases every lock it owns. A
        // normal pool release here could preserve a leaked, reentrant lock.
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

export { schema };
export type DbSchema = typeof schema;
