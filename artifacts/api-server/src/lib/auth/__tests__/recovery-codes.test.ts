import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// The shared db must never be used when a transaction executor is passed.
const dbExecute = vi.hoisted(() => vi.fn());
vi.mock("../../db-client.js", () => ({ db: { execute: dbExecute } }));

import { RECOVERY_CODE_COUNT, replaceRecoveryCodes } from "../recovery-codes.js";

const USER_ID = "00000000-0000-4000-8000-0000000000a1";

describe("replaceRecoveryCodes", () => {
  // Finding: two overlapping generations could both DELETE before either
  // INSERT, leaving 20 valid codes. The per-user lock comes first, on the
  // executor the caller passed (its transaction).
  it("locks the user's row on the given executor before the DELETE", async () => {
    const statements: Array<{ text: string; params: unknown[] }> = [];
    const executor = {
      execute: vi.fn(async (query: SQL) => {
        const { sql, params } = new PgDialect().sqlToQuery(query);
        statements.push({ text: sql.replace(/\s+/g, " ").trim(), params });
        return { rows: [] };
      })
    };

    const codes = await replaceRecoveryCodes(USER_ID, executor);

    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(dbExecute).not.toHaveBeenCalled();
    expect(statements[0]).toEqual({
      text: "SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE",
      params: [USER_ID]
    });
    expect(statements[1]).toEqual({
      text: "DELETE FROM user_recovery_codes WHERE user_id = $1::uuid",
      params: [USER_ID]
    });
    const inserts = statements.slice(2);
    expect(inserts).toHaveLength(RECOVERY_CODE_COUNT);
    for (const insert of inserts) {
      expect(insert.text).toMatch(/^INSERT INTO user_recovery_codes \(user_id, code_hash\)/);
      expect(insert.params[0]).toBe(USER_ID);
    }
  });
});
