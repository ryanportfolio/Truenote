import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessions, users } from "@workspace/db/schema";

// Finding: POST /api/auth/change-password replaced the caller's session with
// a 7-day local one, so an SSO (oidc) session either ended at the next
// request (break_glass, disabled: findSessionByToken refuses local
// sessions) or escaped the SSO idle and absolute limits (enabled). The
// replacement now keeps the current session's auth_method, auth_time and
// expires_at; a local session is still replaced by a 7-day local one. The
// real handler runs; the database, password hashing and audit are faked.

const fake = vi.hoisted(() => ({
  log: [] as string[],
  committed: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  currentSession: [] as Array<Record<string, unknown>>,
  sessionLookup: null as null | { sql: string; params: unknown[]; lock: unknown }
}));

vi.mock("../../lib/db-client.js", () => ({
  db: {
    // The current hash, read before the transaction.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ passwordHash: "old-password-hash" }] }) }) }),
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: string[] = [];
      const record = (entry: string) => {
        fake.log.push(entry);
        pending.push(entry);
      };
      const tx = {
        update: (table: unknown) => ({ set: () => ({ where: async () => {
          expect(table).toBe(users);
          record("update-password");
        } }) }),
        select: () => ({ from: (table: unknown) => ({ where: (condition: SQL) => {
          expect(table).toBe(sessions);
          const { sql, params } = new PgDialect().sqlToQuery(condition);
          return {
            for: (lock: unknown) => ({ limit: async () => {
              fake.sessionLookup = { sql, params, lock };
              record("read-session");
              return fake.currentSession;
            } })
          };
        } }) }),
        delete: (table: unknown) => ({ where: async () => {
          expect(table).toBe(sessions);
          record("revoke-sessions");
        } }),
        insert: (table: unknown) => ({ values: async (values: Record<string, unknown>) => {
          expect(table).toBe(sessions);
          fake.inserted.push(values);
          record("insert-session");
        } }),
        execute: async () => {
          record("invalidate-mfa");
          return { rows: [] };
        }
      };
      const result = await work(tx);
      fake.committed.push(...pending);
      return result;
    }
  }
}));
vi.mock("../../lib/auth/passwords.js", () => ({
  hashPassword: async () => "new-password-hash",
  verifyPassword: async () => true
}));
vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEventBestEffort: vi.fn(),
  appendSecurityEvent: vi.fn()
}));

import { authRouter } from "../auth.js";
import { hashToken, SESSION_COOKIE_NAME, SESSION_DURATION_MS } from "../../lib/auth/sessions.js";
import type { CurrentUser } from "../../lib/auth/current-user.js";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

const handler = (() => {
  const stack = (authRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const route = stack.find((layer) => layer.route?.path === "/change-password" && layer.route.methods.post)?.route;
  return route?.stack[route.stack.length - 1]?.handle;
})();

const SELF: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000b1",
  email: "person@example.com",
  role: "csr",
  programId: "00000000-0000-4000-8000-0000000000f1",
  name: "Person",
  mustResetPassword: false
};
const CURRENT_TOKEN = "synthetic-current-session-token";
const body = { currentPassword: "old-password-value", newPassword: "synthetic-new-password-long-enough-for-policy" };

async function changePassword(cookies: Record<string, string> = { [SESSION_COOKIE_NAME]: CURRENT_TOKEN }) {
  expect(handler, "POST /change-password must be mounted").toBeDefined();
  let status = 200;
  let payload: unknown;
  const cookie = vi.fn();
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { payload = value; return response; },
    cookie
  };
  const next = vi.fn();
  await handler!(
    { ip: "203.0.113.7", header: () => undefined, params: {}, user: SELF, body, cookies } as unknown as Request,
    response as unknown as Response,
    next
  );
  expect(next).not.toHaveBeenCalled();
  return { status, payload, cookie };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DEMO_LOGIN_ACCOUNTS", undefined);
  fake.log = [];
  fake.committed = [];
  fake.inserted = [];
  fake.currentSession = [];
  fake.sessionLookup = null;
});

describe("POST /api/auth/change-password replacement session", () => {
  it("keeps an oidc session's auth_method, auth_time and expires_at", async () => {
    const authTime = new Date(Date.now() - 2 * 60 * 60_000);
    const expiresAt = new Date(Date.now() + 6 * 60 * 60_000);
    fake.currentSession = [{ authMethod: "oidc", authTime, expiresAt }];

    const result = await changePassword();
    expect(result.status).toBe(200);
    expect(fake.committed).toEqual([
      "update-password", "read-session", "invalidate-mfa", "revoke-sessions", "insert-session"
    ]);

    // The current session is found by the request's token, for this user,
    // and locked.
    expect(fake.sessionLookup!.params).toEqual(expect.arrayContaining([hashToken(CURRENT_TOKEN), SELF.id]));
    expect(fake.sessionLookup!.sql).toMatch(/"sessions"."expires_at" > /);
    expect(fake.sessionLookup!.lock).toBe("update");

    expect(fake.inserted).toHaveLength(1);
    const row = fake.inserted[0]!;
    expect(row).toEqual({
      userId: SELF.id,
      tokenHash: expect.any(String),
      authMethod: "oidc",
      authTime,
      expiresAt
    });

    // The cookie carries the new token and ends with the session.
    expect(result.cookie).toHaveBeenCalledTimes(1);
    const [name, token, options] = result.cookie.mock.calls[0]!;
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(token).not.toBe(CURRENT_TOKEN);
    expect(row.tokenHash).toBe(hashToken(token));
    const maxAge = (options as { maxAge: number }).maxAge;
    expect(maxAge).toBeLessThanOrEqual(expiresAt.getTime() - Date.now() + 1000);
    expect(maxAge).toBeGreaterThan(expiresAt.getTime() - Date.now() - 60_000);
  });

  it("replaces a local session with a new 7-day local session", async () => {
    fake.currentSession = [{
      authMethod: "local",
      authTime: new Date(Date.now() - 3 * 24 * 60 * 60_000),
      expiresAt: new Date(Date.now() + 4 * 24 * 60 * 60_000)
    }];
    const before = Date.now();

    const result = await changePassword();
    expect(result.status).toBe(200);
    expect(fake.inserted).toHaveLength(1);
    const row = fake.inserted[0]!;
    // No auth_method or auth_time: the column defaults ('local', now()).
    expect(row).toEqual({ userId: SELF.id, tokenHash: expect.any(String), expiresAt: expect.any(Date) });
    const expiresAt = (row.expiresAt as Date).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + SESSION_DURATION_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_DURATION_MS);

    const [, token, options] = result.cookie.mock.calls[0]!;
    expect(row.tokenHash).toBe(hashToken(token));
    expect((options as { maxAge: number }).maxAge).toBe(SESSION_DURATION_MS);
  });

  it("rolls the change back with 401 when the current session is gone", async () => {
    fake.currentSession = [];
    const result = await changePassword();
    expect(result.status).toBe(401);
    expect(result.payload).toEqual({ error: "Unauthorized" });
    expect(fake.log).toEqual(["update-password", "read-session"]);
    expect(fake.committed).toEqual([]);
    expect(fake.inserted).toEqual([]);
    expect(result.cookie).not.toHaveBeenCalled();
  });

  it("rolls the change back with 401 when the request carries no session cookie", async () => {
    const result = await changePassword({});
    expect(result.status).toBe(401);
    expect(fake.log).toEqual(["update-password"]);
    expect(fake.committed).toEqual([]);
    expect(result.cookie).not.toHaveBeenCalled();
  });
});
