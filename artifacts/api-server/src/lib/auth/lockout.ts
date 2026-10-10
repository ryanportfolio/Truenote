import { and, eq, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import { users } from "@workspace/db/schema";
import type { UserRole } from "@workspace/db/schema";
import { db } from "../db-client.js";
import { recordSecurityEventBestEffort } from "../security/audit.js";
import { isDemoEmail } from "./demo-accounts.js";

/**
 * Per-account lockout (users.failed_login_count, users.locked_until;
 * lib/db/sql/0011_login_lockout.sql). The per-IP limiter in rate-limit.ts
 * allows 2000 attempts per 10 minutes per address, so a guesser spread over
 * many addresses could otherwise try one account without limit.
 *
 * After LOGIN_LOCKOUT_THRESHOLD consecutive failures the account is locked
 * for LOGIN_LOCKOUT_MINUTES. While locked, callers refuse every attempt
 * (even a correct one) with their generic failure response and do not
 * verify the credential. A success resets the count.
 *
 * Callers pass a `factor` so the same counter can cover a second factor
 * later; the count is per account, not per factor.
 *
 * Demo accounts (DEMO_LOGIN_ACCOUNTS) are exempt: their passwords are
 * published on /api/config, so locking them would let any visitor block
 * the demo for everyone.
 */

const DEFAULT_THRESHOLD = 5;
const THRESHOLD_MIN = 3;
const THRESHOLD_MAX = 100;
const DEFAULT_MINUTES = 30;
const MINUTES_MIN = 1;
const MINUTES_MAX = 24 * 60;

export interface LockoutPolicy {
  threshold: number;
  minutes: number;
}

function parseBounded(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[config] ${name} is out of range [${min}, ${max}]; using default ${fallback}.`
    );
    return fallback;
  }
  return parsed;
}

// Keyed on the raw values so a bad value warns once, while tests that swap
// the variables per case still see the new value.
let policyCache: {
  rawThreshold: string | undefined;
  rawMinutes: string | undefined;
  policy: LockoutPolicy;
} | null = null;

export function getLockoutPolicy(): LockoutPolicy {
  const rawThreshold = process.env.LOGIN_LOCKOUT_THRESHOLD;
  const rawMinutes = process.env.LOGIN_LOCKOUT_MINUTES;
  if (
    !policyCache ||
    policyCache.rawThreshold !== rawThreshold ||
    policyCache.rawMinutes !== rawMinutes
  ) {
    policyCache = {
      rawThreshold,
      rawMinutes,
      policy: {
        threshold: parseBounded(
          "LOGIN_LOCKOUT_THRESHOLD",
          rawThreshold,
          DEFAULT_THRESHOLD,
          THRESHOLD_MIN,
          THRESHOLD_MAX
        ),
        minutes: parseBounded(
          "LOGIN_LOCKOUT_MINUTES",
          rawMinutes,
          DEFAULT_MINUTES,
          MINUTES_MIN,
          MINUTES_MAX
        )
      }
    };
  }
  return policyCache.policy;
}

export interface LockoutAccount {
  id: string;
  email: string;
  role: UserRole;
  programId: string | null;
}

export type LockoutFactor = "password" | "passkey" | "recovery_code";

export interface LockoutContext {
  factor: LockoutFactor;
  sourceIp: string | null;
}

/** True while the account's lock is in force. Demo accounts never lock. */
export function isAccountLocked(
  account: { email: string; lockedUntil: Date | null | undefined },
  now: Date = new Date()
): boolean {
  if (isDemoEmail(account.email)) return false;
  return account.lockedUntil != null && account.lockedUntil.getTime() > now.getTime();
}

export interface FailureResult {
  /** The account is locked after this failure (new or already in force). */
  locked: boolean;
  /** This failure reached the threshold and started the lock. */
  lockedNow: boolean;
  lockedUntil: Date | null;
}

/**
 * Count one failed attempt. One UPDATE ... RETURNING, so concurrent
 * failures cannot both read the same count. Every SET expression reads the
 * pre-update row: reaching the threshold resets the count to 0 and sets
 * locked_until; otherwise the count goes up by one. A returned count of 0
 * therefore means this failure locked the account (the threshold is at
 * least 1, so a plain increment never returns 0).
 *
 * The WHERE skips accounts whose lock is still in force, so a failure that
 * races a lock neither extends it nor starts a new count.
 */
export async function recordAuthFailure(
  account: LockoutAccount,
  context: LockoutContext
): Promise<FailureResult> {
  if (isDemoEmail(account.email)) {
    return { locked: false, lockedNow: false, lockedUntil: null };
  }
  const { threshold, minutes } = getLockoutPolicy();
  const reached = sql`${users.failedLoginCount} + 1 >= ${threshold}::integer`;
  const rows = await db
    .update(users)
    .set({
      failedLoginCount: sql`CASE WHEN ${reached} THEN 0 ELSE ${users.failedLoginCount} + 1 END`,
      lockedUntil: sql`CASE WHEN ${reached} THEN now() + make_interval(mins => ${minutes}::integer) ELSE ${users.lockedUntil} END`
    })
    .where(
      and(
        eq(users.id, account.id),
        or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`))
      )
    )
    .returning({
      failedLoginCount: users.failedLoginCount,
      lockedUntil: users.lockedUntil
    });

  const row = rows[0];
  if (!row) {
    // The lock was already in force (or the account vanished). Nothing new
    // to record.
    return { locked: true, lockedNow: false, lockedUntil: null };
  }
  if (row.failedLoginCount !== 0) {
    return { locked: false, lockedNow: false, lockedUntil: null };
  }

  recordSecurityEventBestEffort({
    action: "auth.account.locked",
    outcome: "denied",
    actor: { id: account.id, email: account.email, role: account.role },
    programId: account.programId,
    resourceType: "user",
    resourceId: account.id,
    sourceIp: context.sourceIp,
    details: {
      factor: context.factor,
      threshold,
      lockMinutes: minutes,
      lockedUntil: row.lockedUntil ? row.lockedUntil.toISOString() : null
    }
  });
  return { locked: true, lockedNow: true, lockedUntil: row.lockedUntil };
}

/**
 * Reset the count and clear any lock after a successful attempt. The WHERE
 * skips the write for accounts with nothing to clear.
 */
export async function recordAuthSuccess(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ failedLoginCount: 0, lockedUntil: null })
    .where(
      and(
        eq(users.id, userId),
        or(ne(users.failedLoginCount, 0), isNotNull(users.lockedUntil))
      )
    );
}
