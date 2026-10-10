import { createHash, randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";

/**
 * Single-use recovery codes for the break-glass second factor
 * (`user_recovery_codes`, lib/db/sql/0017_break_glass_mfa.sql).
 *
 * Each code is 10 random bytes (80 bits) written as 16 base32 characters in
 * four groups of four. Only the SHA-256 hex of the normalized code is
 * stored; at 80 bits a stolen hash cannot be reversed by guessing. Entry is
 * normalized (case, spaces and hyphens ignored) before hashing.
 */

export const RECOVERY_CODE_COUNT = 10;
const CODE_BYTES = 10;
// RFC 4648 base32 alphabet, lowercase. 10 bytes = 80 bits = 16 characters.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function generateRecoveryCode(): string {
  const raw = base32(randomBytes(CODE_BYTES));
  return raw.match(/.{1,4}/g)!.join("-");
}

/** Lowercase and drop spaces and hyphens; null when the shape cannot be a code. */
export function normalizeRecoveryCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-z2-7]{16}$/.test(compact) ? compact : null;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/**
 * Replace every recovery code of the user with RECOVERY_CODE_COUNT new ones
 * and return the plaintext codes. Runs on the caller's executor:
 * POST /api/auth/mfa/recovery-codes (routes/mfa.ts) passes a transaction
 * that also appends the `auth.mfa.recovery_codes.generated` audit event, so
 * the replacement and its event commit or roll back together.
 *
 * The user's row is locked first (SELECT ... FOR UPDATE), so two overlapping
 * generations run one after the other: without it both could delete before
 * either inserts, leaving 20 valid codes. The lock lasts until the caller's
 * transaction ends; on a bare `db` executor it would end at once.
 */
export async function replaceRecoveryCodes(
  userId: string,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await executor.execute(sql`
    SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE
  `);
  await executor.execute(sql`
    DELETE FROM user_recovery_codes WHERE user_id = ${userId}::uuid
  `);
  for (const code of codes) {
    const hash = hashRecoveryCode(normalizeRecoveryCode(code)!);
    await executor.execute(sql`
      INSERT INTO user_recovery_codes (user_id, code_hash)
      VALUES (${userId}::uuid, ${hash})
    `);
  }
  return codes;
}

/**
 * Mark one unused code spent. One UPDATE ... RETURNING, so two concurrent
 * uses of the same code cannot both succeed. Returns false when the code is
 * unknown, belongs to another user, or was already used.
 */
export async function consumeRecoveryCode(
  userId: string,
  input: string,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<boolean> {
  const normalized = normalizeRecoveryCode(input);
  if (!normalized) return false;
  const result = await executor.execute(sql`
    UPDATE user_recovery_codes
    SET used_at = now()
    WHERE user_id = ${userId}::uuid
      AND code_hash = ${hashRecoveryCode(normalized)}
      AND used_at IS NULL
    RETURNING id
  `);
  return result.rows.length > 0;
}

export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const result = await db.execute(sql`
    SELECT count(*)::int AS unused
    FROM user_recovery_codes
    WHERE user_id = ${userId}::uuid AND used_at IS NULL
  `);
  const row = result.rows[0] as { unused?: unknown } | undefined;
  return typeof row?.unused === "number" ? row.unused : Number(row?.unused ?? 0);
}
