import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQL } from "drizzle-orm";

// One stored account. The fake db applies lockout.ts's two UPDATEs to it:
// the failure UPDATE (SQL CASE expressions, whose exact text
// lib/auth/__tests__/lockout.test.ts pins) is emulated here with the same
// rule, and the success UPDATE writes plain values.
const fake = vi.hoisted(() => ({
  account: {} as Record<string, unknown>,
  now: () => new Date(),
  policy: (): { threshold: number; minutes: number } => {
    throw new Error("policy not wired");
  },
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  audit: vi.fn(),
  insert: vi.fn(),
  failureUpdates: 0,
  successUpdates: 0,
  // Success UPDATEs sent on a transaction executor, and whether a
  // transaction is open.
  successUpdatesInTx: 0,
  inTx: false,
  // When set, runs once as the next transaction starts: a write another
  // connection commits after the request's unlocked checks.
  beforeNextTransaction: null as (() => void) | null
}));

vi.mock("../../lib/db-client.js", () => {
  const applyUpdate = (values: Record<string, unknown>, onTx: boolean) => {
    const a = fake.account;
    if (values.failedLoginCount instanceof SQL) {
      fake.failureUpdates += 1;
      const lockedUntil = a.lockedUntil as Date | null;
      if (lockedUntil && lockedUntil.getTime() > fake.now().getTime()) return [];
      const { threshold, minutes } = fake.policy();
      const next = (a.failedLoginCount as number) + 1;
      if (next >= threshold) {
        a.failedLoginCount = 0;
        a.lockedUntil = new Date(fake.now().getTime() + minutes * 60_000);
      } else {
        a.failedLoginCount = next;
      }
      return [{ failedLoginCount: a.failedLoginCount, lockedUntil: a.lockedUntil }];
    }
    if (values.failedLoginCount === 0) {
      fake.successUpdates += 1;
      if (onTx && fake.inTx) fake.successUpdatesInTx += 1;
      a.failedLoginCount = 0;
      a.lockedUntil = values.lockedUntil;
    }
    return [];
  };
  // No passkeys enrolled (lib/auth/mfa.ts listPasskeys). The user-row lock
  // of the session transaction (lockUserAccount) reads the stored hash,
  // is_active and locked_until.
  const execute = async (query: SQL) =>
    query.queryChunks.some((chunk) => String((chunk as { value?: unknown }).value ?? "").includes("FOR UPDATE"))
      ? {
          rows: [{
            password_hash: fake.account.passwordHash,
            is_active: fake.account.isActive,
            locked_until: fake.account.lockedUntil
          }]
        }
      : { rows: [] };
  const insert = () => {
    fake.insert();
    return { values: async () => undefined };
  };
  const update = (onTx: boolean) => () => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        let rows: unknown[] | null = null;
        const run = () => (rows ??= applyUpdate(values, onTx));
        return Object.assign(Promise.resolve().then(run), {
          returning: async () => run()
        });
      }
    })
  });
  return {
    db: {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ ...fake.account }] }) })
      }),
      execute,
      insert,
      transaction: async (work: (tx: unknown) => Promise<unknown>) => {
        const before = fake.beforeNextTransaction;
        fake.beforeNextTransaction = null;
        before?.();
        fake.inTx = true;
        try {
          return await work({ execute, insert, update: update(true) });
        } finally {
          fake.inTx = false;
        }
      },
      update: update(false)
    }
  };
});
vi.mock("../../lib/auth/passwords.js", () => ({
  verifyPassword: fake.verifyPassword,
  hashPassword: fake.hashPassword
}));
vi.mock("../../lib/security/audit.js", () => ({ recordSecurityEventBestEffort: fake.audit }));
vi.mock("../../lib/auth/rate-limit.js", () => ({
  clientIpFrom: () => "203.0.113.7",
  loginIpLimiter: { hit: () => true },
  forgotPasswordEmailLimiter: { hit: () => true },
  forgotPasswordIpLimiter: { hit: () => true }
}));

import { authRouter } from "../auth.js";
import { getLockoutPolicy } from "../../lib/auth/lockout.js";

fake.policy = getLockoutPolicy;

const STORED_HASH = "stored-password-hash";
const CORRECT = "correct-password";
const WRONG = "wrong-password";
const envNames = [
  "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI",
  "OIDC_STATE_SECRET", "LOCAL_LOGIN_MODE", "DEMO_LOGIN_ACCOUNTS",
  "LOGIN_LOCKOUT_THRESHOLD", "LOGIN_LOCKOUT_MINUTES"
];

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
const handler = (authRouter as unknown as {
  stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
}).stack.find((layer) => layer.route?.path === "/login" && layer.route.methods.post)?.route?.stack[0]?.handle;

async function login(password: string) {
  expect(handler).toBeDefined();
  let status = 200;
  let body: unknown;
  const cookie = vi.fn();
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { body = value; return response; },
    cookie
  };
  const next = vi.fn();
  await handler!(
    { body: { email: fake.account.email, password } } as Request,
    response as unknown as Response, next
  );
  expect(next).not.toHaveBeenCalled();
  // Let the fire-and-forget failure count land before the next attempt.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { status, body, cookie };
}

function events(action: string) {
  return fake.audit.mock.calls.map(([event]) => event).filter((event) => event.action === action);
}

beforeEach(() => {
  vi.clearAllMocks();
  envNames.forEach((name) => vi.stubEnv(name, undefined));
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
  fake.now = () => new Date();
  fake.failureUpdates = 0;
  fake.successUpdates = 0;
  fake.successUpdatesInTx = 0;
  fake.inTx = false;
  fake.beforeNextTransaction = null;
  fake.account = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "person@example.com",
    passwordHash: STORED_HASH,
    role: "csr",
    programId: "00000000-0000-4000-8000-000000000002",
    name: "Person",
    isActive: true,
    mustResetPassword: false,
    failedLoginCount: 0,
    lockedUntil: null
  };
  fake.hashPassword.mockResolvedValue("dummy-password-hash");
  fake.verifyPassword.mockImplementation(
    async (password: string, hash: string) => hash === STORED_HASH && password === CORRECT
  );
});
afterEach(() => vi.unstubAllEnvs());

async function failTimes(count: number) {
  for (let i = 0; i < count; i += 1) {
    const result = await login(WRONG);
    expect(result).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
  }
}

describe("local login lockout", () => {
  it("locks after 5 consecutive failures and writes one lockout event", async () => {
    await failTimes(4);
    expect(fake.account.failedLoginCount).toBe(4);
    expect(fake.account.lockedUntil).toBeNull();
    expect(events("auth.account.locked")).toHaveLength(0);

    await failTimes(1);
    expect(fake.account.failedLoginCount).toBe(0);
    const lockedUntil = fake.account.lockedUntil as Date;
    expect(lockedUntil.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(lockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    const locked = events("auth.account.locked");
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({
      outcome: "denied",
      actor: { id: fake.account.id, email: fake.account.email, role: "csr" },
      resourceType: "user",
      resourceId: fake.account.id,
      sourceIp: "203.0.113.7",
      details: { factor: "password", threshold: 5, lockMinutes: 30 }
    });
    expect(JSON.stringify(fake.audit.mock.calls)).not.toMatch(/correct-password|wrong-password|stored-password-hash/);
  });

  it("refuses the correct password while locked, without verifying the stored hash", async () => {
    await failTimes(5);
    fake.verifyPassword.mockClear();
    fake.audit.mockClear();
    const updatesBefore = fake.failureUpdates;

    const result = await login(CORRECT);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "Invalid credentials" });
    expect(result.cookie).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.verifyPassword).toHaveBeenCalledTimes(1);
    expect(fake.verifyPassword).toHaveBeenCalledWith(CORRECT, "dummy-password-hash");
    expect(fake.verifyPassword).not.toHaveBeenCalledWith(expect.anything(), STORED_HASH);
    // Attempts during the lock neither count nor extend it.
    expect(fake.failureUpdates).toBe(updatesBefore);
    expect(fake.audit).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.local.login",
      outcome: "denied",
      details: expect.objectContaining({ reason: "account_locked" })
    }));
  });

  it("returns the same response for correct and wrong passwords while locked", async () => {
    await failTimes(5);
    const correct = await login(CORRECT);
    const wrong = await login(WRONG);
    expect({ status: correct.status, body: correct.body })
      .toEqual({ status: wrong.status, body: wrong.body });
  });

  it("lets the account log in again once the lock expires, and that success resets it", async () => {
    await failTimes(5);
    const lockedUntil = fake.account.lockedUntil as Date;
    fake.account.lockedUntil = new Date(Date.now() - 1000);
    expect(lockedUntil.getTime()).toBeGreaterThan(Date.now());

    const result = await login(CORRECT);
    expect(result.status).toBe(200);
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.account.lockedUntil).toBeNull();
    expect(fake.account.failedLoginCount).toBe(0);
  });

  it("resets the count on success, so failures must be consecutive", async () => {
    await failTimes(4);
    const success = await login(CORRECT);
    expect(success.status).toBe(200);
    expect(fake.successUpdates).toBe(1);
    expect(fake.account.failedLoginCount).toBe(0);

    await failTimes(4);
    expect(fake.account.lockedUntil).toBeNull();
    expect((await login(CORRECT)).status).toBe(200);
    expect(events("auth.account.locked")).toHaveLength(0);
  });

  it("honors LOGIN_LOCKOUT_THRESHOLD and LOGIN_LOCKOUT_MINUTES", async () => {
    vi.stubEnv("LOGIN_LOCKOUT_THRESHOLD", "3");
    vi.stubEnv("LOGIN_LOCKOUT_MINUTES", "10");
    await failTimes(3);
    const lockedUntil = fake.account.lockedUntil as Date;
    expect(lockedUntil.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(lockedUntil.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(events("auth.account.locked")[0]).toMatchObject({
      details: { threshold: 3, lockMinutes: 10 }
    });
    expect((await login(CORRECT)).status).toBe(401);
  });

  it("never locks a demo account", async () => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "CSR", email: "person@example.com", password: CORRECT }
    ]));
    await failTimes(12);
    expect(fake.failureUpdates).toBe(0);
    expect(fake.account.lockedUntil).toBeNull();
    expect(events("auth.account.locked")).toHaveLength(0);
    expect((await login(CORRECT)).status).toBe(200);
  });

  it("does not let a stale lock block a demo account", async () => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "CSR", email: "person@example.com", password: CORRECT }
    ]));
    fake.account.lockedUntil = new Date(Date.now() + 60 * 60_000);
    expect((await login(CORRECT)).status).toBe(200);
  });
});

// Finding: a correct password that passed the unlocked isAccountLocked check
// could still get a session after a concurrent failure locked the account,
// and the following recordAuthSuccess cleared that lock.
describe("lockout rechecked under the user row lock", () => {
  it("refuses a correct password when the account locked after the unlocked check, and leaves the lock", async () => {
    await failTimes(4);
    const lockedUntil = new Date(Date.now() + 30 * 60_000);
    // The fifth failure, on another connection, commits between this
    // request's unlocked checks and its locking transaction.
    fake.beforeNextTransaction = () => {
      fake.account.failedLoginCount = 0;
      fake.account.lockedUntil = lockedUntil;
    };
    fake.audit.mockClear();
    const updatesBefore = fake.failureUpdates;

    const result = await login(CORRECT);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "Invalid credentials" });
    expect(result.cookie).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.successUpdates).toBe(0);
    expect(fake.failureUpdates).toBe(updatesBefore);
    expect(fake.account.failedLoginCount).toBe(0);
    expect(fake.account.lockedUntil).toBe(lockedUntil);
    expect(fake.audit).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.local.login",
      outcome: "denied",
      details: { authMethod: "local", reason: "account_locked" }
    }));

    // The lock still refuses the next correct attempt.
    expect((await login(CORRECT)).status).toBe(401);
    expect(fake.account.lockedUntil).toBe(lockedUntil);
  });

  it("resets the count inside the session transaction", async () => {
    await failTimes(4);
    const result = await login(CORRECT);
    expect(result.status).toBe(200);
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.successUpdates).toBe(1);
    expect(fake.successUpdatesInTx).toBe(1);
    expect(fake.account.failedLoginCount).toBe(0);
    expect(fake.account.lockedUntil).toBeNull();
  });

  it("still lets a demo account in when a lock appears after the unlocked check", async () => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "CSR", email: "person@example.com", password: CORRECT }
    ]));
    fake.beforeNextTransaction = () => {
      fake.account.lockedUntil = new Date(Date.now() + 60 * 60_000);
    };
    expect((await login(CORRECT)).status).toBe(200);
    expect(fake.insert).toHaveBeenCalledTimes(1);
  });
});
