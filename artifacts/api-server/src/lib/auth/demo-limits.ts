import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db-client.js";
import { isDemoEmail } from "./demo-accounts.js";

/**
 * The super user's master switch for demo-account limits (Security page).
 * On, the default: demo accounts are read-only outside their personal
 * features (blockDemoWrites, Sources organizing, team pins). Off: they act
 * like normal accounts of their role. Password change and reset stay
 * blocked either way, since one visitor rotating a published password
 * locks every other visitor out of the demo.
 *
 * Stored in app_settings under `demo_limits` as `{ "enabled": boolean }`.
 */
export const DEMO_LIMITS_SETTING_KEY = "demo_limits";

const StoredSchema = z.object({ enabled: z.boolean() });

export interface DemoLimitsPolicy {
  enabled: boolean;
  persistenceReady: boolean;
  updatedAt: string | null;
  updatedByName: string | null;
  updatedByEmail: string | null;
}

interface PolicyRow {
  value: unknown;
  updated_at: Date | string | null;
  updated_by_name: string | null;
  updated_by_email: string | null;
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

/** Missing or malformed settings keep the limits on. */
export function resolveDemoLimitsEnabled(value: unknown): boolean {
  const parsed = StoredSchema.safeParse(value);
  return parsed.success ? parsed.data.enabled : true;
}

export async function getDemoLimitsPolicy(): Promise<DemoLimitsPolicy> {
  try {
    const result = await db.execute(sql`
      SELECT setting.value,
             setting.updated_at,
             updater.name AS updated_by_name,
             updater.email AS updated_by_email
      FROM app_settings setting
      LEFT JOIN users updater ON updater.id = setting.updated_by
      WHERE setting.key = ${DEMO_LIMITS_SETTING_KEY}
      LIMIT 1
    `);
    const row = result.rows[0] as unknown as PolicyRow | undefined;
    return {
      enabled: resolveDemoLimitsEnabled(row?.value),
      persistenceReady: true,
      updatedAt: row?.updated_at instanceof Date ? row.updated_at.toISOString() : row?.updated_at ?? null,
      updatedByName: row?.updated_by_name ?? null,
      updatedByEmail: row?.updated_by_email ?? null
    };
  } catch {
    // Fail closed: an unreadable settings table keeps demo accounts limited.
    return { enabled: true, persistenceReady: false, updatedAt: null, updatedByName: null, updatedByEmail: null };
  }
}

export async function persistDemoLimitsPolicy(
  enabled: boolean,
  updatedBy: string,
  executor: SqlExecutor
): Promise<void> {
  const value = JSON.stringify({ enabled });
  await executor.execute(sql`
    INSERT INTO app_settings (key, value, updated_by, updated_at)
    VALUES (${DEMO_LIMITS_SETTING_KEY}, ${value}::jsonb, ${updatedBy}::uuid, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  `);
}

// Demo requests check the switch on every write, so the value is cached
// briefly. The route clears it once a save commits; another replica sees
// the change within CACHE_MS of its own last read starting. A read that
// started before a clear is not cached, so it can't outlive the save.
const CACHE_MS = 5_000;
let cached: { enabled: boolean; at: number } | null = null;
let generation = 0;

export function forgetDemoLimits(): void {
  cached = null;
  generation += 1;
}

async function demoLimitsEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.enabled;
  const startedAt = Date.now();
  const startedGeneration = generation;
  const { enabled } = await getDemoLimitsPolicy();
  if (generation === startedGeneration) cached = { enabled, at: startedAt };
  return enabled;
}

/**
 * True when this email is a demo account AND the super user has the demo
 * limits on. Non-demo emails never touch the database.
 */
export async function isLimitedDemo(email: string): Promise<boolean> {
  if (!isDemoEmail(email)) return false;
  return demoLimitsEnabled();
}
