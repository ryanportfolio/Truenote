import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Real Drizzle query building over a fake node-postgres client, so the
// tests see the exact SQL text and parameters lockout.ts sends.
const fake = vi.hoisted(() => ({
  queries: [] as Array<{ text: string; params: unknown[] }>,
  rows: [] as unknown[][],
  audit: vi.fn()
}));

vi.mock("../../db-client.js", async () => {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const schema = await import("@workspace/db/schema");
  const client = {
    query: async (config: string | { text: string }, params: unknown[] = []) => {
      const text = typeof config === "string" ? config : config.text;
      fake.queries.push({ text, params });
      return { rows: fake.rows, rowCount: fake.rows.length, fields: [] };
    }
  };
  return { db: drizzle(client as never, { schema }) };
});
vi.mock("../../security/audit.js", () => ({ recordSecurityEventBestEffort: fake.audit }));

import {
  getLockoutPolicy,
  isAccountLocked,
  recordAuthFailure,
  recordAuthSuccess
} from "../lockout.js";

const account = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  role: "csr" as const,
  programId: "00000000-0000-4000-8000-000000000002"
};
const context = { factor: "password" as const, sourceIp: "203.0.113.7" };

beforeEach(() => {
  vi.clearAllMocks();
  fake.queries = [];
  fake.rows = [];
  vi.stubEnv("LOGIN_LOCKOUT_THRESHOLD", undefined);
  vi.stubEnv("LOGIN_LOCKOUT_MINUTES", undefined);
  vi.stubEnv("DEMO_LOGIN_ACCOUNTS", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("lockout policy configuration", () => {
  it("defaults to 5 failures and 30 minutes", () => {
    expect(getLockoutPolicy()).toEqual({ threshold: 5, minutes: 30 });
  });

  it("accepts values inside the bounds", () => {
    vi.stubEnv("LOGIN_LOCKOUT_THRESHOLD", "10");
    vi.stubEnv("LOGIN_LOCKOUT_MINUTES", "15");
    expect(getLockoutPolicy()).toEqual({ threshold: 10, minutes: 15 });
  });

  it.each([
    ["0", "0"], ["2", "1441"], ["101", "-5"], ["abc", "1.5"], ["5x", "30m"]
  ])("falls back to defaults for threshold %s and minutes %s", (threshold, minutes) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("LOGIN_LOCKOUT_THRESHOLD", threshold);
    vi.stubEnv("LOGIN_LOCKOUT_MINUTES", minutes);
    expect(getLockoutPolicy()).toEqual({ threshold: 5, minutes: 30 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("isAccountLocked", () => {
  const now = new Date("2026-10-10T12:00:00Z");

  it("is locked only while locked_until is in the future", () => {
    expect(isAccountLocked({ email: account.email, lockedUntil: null }, now)).toBe(false);
    expect(isAccountLocked({ email: account.email, lockedUntil: undefined }, now)).toBe(false);
    expect(isAccountLocked({ email: account.email, lockedUntil: new Date("2026-10-10T11:59:59Z") }, now)).toBe(false);
    expect(isAccountLocked({ email: account.email, lockedUntil: now }, now)).toBe(false);
    expect(isAccountLocked({ email: account.email, lockedUntil: new Date("2026-10-10T12:00:01Z") }, now)).toBe(true);
  });

  it("never reports a demo account as locked", () => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "CSR", email: "Person@Example.com", password: "public-demo-password" }
    ]));
    expect(isAccountLocked({ email: account.email, lockedUntil: new Date("2099-01-01T00:00:00Z") }, now)).toBe(false);
  });
});

describe("recordAuthFailure", () => {
  it("increments, locks and resets in one atomic UPDATE ... RETURNING", async () => {
    vi.stubEnv("LOGIN_LOCKOUT_THRESHOLD", "7");
    vi.stubEnv("LOGIN_LOCKOUT_MINUTES", "45");
    fake.rows = [[3, null]];
    await recordAuthFailure(account, context);
    expect(fake.queries).toHaveLength(1);
    const { text, params } = fake.queries[0]!;
    expect(text).toBe(
      'update "users" set ' +
      '"failed_login_count" = CASE WHEN "users"."failed_login_count" + 1 >= $1::integer THEN 0 ELSE "users"."failed_login_count" + 1 END, ' +
      '"locked_until" = CASE WHEN "users"."failed_login_count" + 1 >= $2::integer THEN now() + make_interval(mins => $3::integer) ELSE "users"."locked_until" END ' +
      'where ("users"."id" = $4 and ("users"."locked_until" is null or "users"."locked_until" <= now())) ' +
      'returning "failed_login_count", "locked_until"'
    );
    expect(params).toEqual([7, 7, 45, account.id]);
  });

  it("returns unlocked without an event below the threshold", async () => {
    fake.rows = [[4, null]];
    await expect(recordAuthFailure(account, context)).resolves.toEqual({
      locked: false, lockedNow: false, lockedUntil: null
    });
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("writes one lockout security event when the failure starts the lock", async () => {
    fake.rows = [[0, "2026-10-10 12:30:00+00"]];
    const result = await recordAuthFailure(account, context);
    expect(result.locked).toBe(true);
    expect(result.lockedNow).toBe(true);
    expect(result.lockedUntil?.toISOString()).toBe("2026-10-10T12:30:00.000Z");
    expect(fake.audit).toHaveBeenCalledTimes(1);
    const event = fake.audit.mock.calls[0]![0];
    expect(event).toEqual({
      action: "auth.account.locked",
      outcome: "denied",
      actor: { id: account.id, email: account.email, role: account.role },
      programId: account.programId,
      resourceType: "user",
      resourceId: account.id,
      sourceIp: context.sourceIp,
      details: {
        factor: "password",
        threshold: 5,
        lockMinutes: 30,
        lockedUntil: "2026-10-10T12:30:00.000Z"
      }
    });
    expect(JSON.stringify(event)).not.toMatch(/password_hash|passwordHash/);
  });

  it("reports an already-locked account without a new event", async () => {
    fake.rows = [];
    await expect(recordAuthFailure(account, context)).resolves.toEqual({
      locked: true, lockedNow: false, lockedUntil: null
    });
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("never counts or locks a demo account", async () => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "CSR", email: account.email, password: "public-demo-password" }
    ]));
    await expect(recordAuthFailure(account, context)).resolves.toEqual({
      locked: false, lockedNow: false, lockedUntil: null
    });
    expect(fake.queries).toHaveLength(0);
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe("recordAuthSuccess", () => {
  it("clears the count and any lock, skipping rows with nothing to clear", async () => {
    await recordAuthSuccess(account.id);
    expect(fake.queries).toHaveLength(1);
    const { text, params } = fake.queries[0]!;
    expect(text).toBe(
      'update "users" set "failed_login_count" = $1, "locked_until" = $2 ' +
      'where ("users"."id" = $3 and ("users"."failed_login_count" <> $4 or "users"."locked_until" is not null))'
    );
    expect(params).toEqual([0, null, account.id, 0]);
  });

  it("sends the same UPDATE on the caller's transaction", async () => {
    const { db } = await import("../../db-client.js");
    await db.transaction(async (tx) => {
      await recordAuthSuccess(account.id, tx);
    });
    expect(fake.queries.map((q) => q.text)).toEqual([
      "begin",
      'update "users" set "failed_login_count" = $1, "locked_until" = $2 ' +
      'where ("users"."id" = $3 and ("users"."failed_login_count" <> $4 or "users"."locked_until" is not null))',
      "commit"
    ]);
  });
});
