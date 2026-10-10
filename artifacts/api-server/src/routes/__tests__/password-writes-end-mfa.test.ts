import type { NextFunction, Request, Response, Router } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { sessions, users } from "@workspace/db/schema";

// Finding: a pending MFA login survived a password change. Every transaction
// that writes a user's password hash must delete that user's unconsumed
// mfa_challenges rows in the same transaction. POST /api/auth/reset-password
// is covered in auth-reset-policy.test.ts and, end to end, in
// mfa-login.test.ts; this file covers POST /api/auth/change-password and the
// admin reset POST /api/admin/users/:id/reset-password. The real handlers
// run; the database, password hashing and audit are faked.

const fake = vi.hoisted(() => ({
  log: [] as string[],
  committed: [] as string[],
  mfaParams: [] as unknown[][],
  failRevoke: null as Error | null,
  passwordRow: [] as Array<Record<string, unknown>>,
  targetRow: [] as Array<Record<string, unknown>>,
  // change-password reads the request's session row inside its transaction.
  sessionRow: [] as Array<Record<string, unknown>>
}));

vi.mock("../../lib/db-client.js", () => ({
  db: {
    // change-password reads the current hash before its transaction.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => fake.passwordRow }) }) }),
    // No execute here: SQL sent outside the transaction would throw.
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      const pending: string[] = [];
      const record = (entry: string) => {
        fake.log.push(entry);
        pending.push(entry);
      };
      const tx = {
        select: () => ({ from: (table: unknown) => ({ where: () => {
          const rows = table === sessions ? fake.sessionRow : fake.targetRow;
          return { for: () => ({ limit: async () => rows }), limit: async () => rows };
        } }) }),
        update: (table: unknown) => ({ set: () => ({ where: async () => {
          expect(table).toBe(users);
          record("update-password");
        } }) }),
        delete: (table: unknown) => ({ where: async () => {
          expect(table).toBe(sessions);
          if (fake.failRevoke) throw fake.failRevoke;
          record("revoke-sessions");
        } }),
        insert: (table: unknown) => ({ values: async () => {
          expect(table).toBe(sessions);
          record("insert-session");
        } }),
        execute: async (query: SQL) => {
          const { sql, params } = new PgDialect().sqlToQuery(query);
          const text = sql.replace(/\s+/g, " ").trim();
          expect(text).toBe("DELETE FROM mfa_challenges WHERE user_id = $1::uuid AND consumed_at IS NULL");
          fake.mfaParams.push(params);
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
import { usersRouter } from "../admin/users.js";
import type { CurrentUser } from "../../lib/auth/current-user.js";

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function lastHandler(router: Router, path: string): Handler {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.post)?.route;
  expect(route, `POST ${path} must be mounted`).toBeDefined();
  return route!.stack[route!.stack.length - 1]!.handle;
}

async function invoke(handler: Handler, req: Record<string, unknown>) {
  let status = 200;
  let body: unknown;
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { body = value; return response; },
    cookie: vi.fn()
  };
  const next = vi.fn();
  await handler(
    { ip: "203.0.113.7", header: () => undefined, params: {}, ...req } as unknown as Request,
    response as unknown as Response,
    next
  );
  return { status, body, next, cookie: response.cookie };
}

const SELF: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000b1",
  email: "person@example.com",
  role: "csr",
  programId: "00000000-0000-4000-8000-0000000000f1",
  name: "Person",
  mustResetPassword: false
};
const ADMIN: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000a1",
  email: "admin@example.com",
  role: "super_user",
  programId: null,
  name: "Admin",
  mustResetPassword: false
};
const TARGET_ID = "00000000-0000-4000-8000-0000000000c1";

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("DEMO_LOGIN_ACCOUNTS", undefined);
  fake.log = [];
  fake.committed = [];
  fake.mfaParams = [];
  fake.failRevoke = null;
  fake.passwordRow = [{ passwordHash: "old-password-hash" }];
  fake.sessionRow = [{
    authMethod: "local",
    authTime: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60 * 60_000)
  }];
  fake.targetRow = [{
    id: TARGET_ID, email: "target@example.com", role: "csr",
    programId: "00000000-0000-4000-8000-0000000000f1"
  }];
});

describe("POST /api/auth/change-password", () => {
  const body = { currentPassword: "old-password-value", newPassword: "synthetic-new-password-long-enough-for-policy" };
  // The handler reads the request's session row (by its cookie token) in
  // the transaction.
  const cookies = { kbase_session: "synthetic-current-session-token" };

  it("deletes the user's unconsumed MFA challenges in the password transaction", async () => {
    const result = await invoke(lastHandler(authRouter, "/change-password"), { user: SELF, body, cookies });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(fake.mfaParams).toEqual([[SELF.id]]);
    expect(fake.committed).toEqual(["update-password", "invalidate-mfa", "revoke-sessions", "insert-session"]);
  });

  it("rolls the invalidation back with the password write", async () => {
    fake.failRevoke = new Error("synthetic revoke failure");
    const result = await invoke(lastHandler(authRouter, "/change-password"), { user: SELF, body, cookies });
    expect(result.next).toHaveBeenCalledWith(fake.failRevoke);
    expect(fake.log).toEqual(["update-password", "invalidate-mfa"]);
    expect(fake.committed).toEqual([]);
    expect(result.cookie).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/users/:id/reset-password", () => {
  it("deletes the target's unconsumed MFA challenges in the reset transaction", async () => {
    const result = await invoke(lastHandler(usersRouter, "/:id/reset-password"), {
      user: ADMIN, params: { id: TARGET_ID }, body: {}
    });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tempPassword: expect.any(String) });
    expect(fake.mfaParams).toEqual([[TARGET_ID]]);
    expect(fake.committed).toEqual(["update-password", "invalidate-mfa", "revoke-sessions"]);
  });

  it("rolls the invalidation back with the password write", async () => {
    fake.failRevoke = new Error("synthetic revoke failure");
    const result = await invoke(lastHandler(usersRouter, "/:id/reset-password"), {
      user: ADMIN, params: { id: TARGET_ID }, body: {}
    });
    expect(result.next).toHaveBeenCalledWith(fake.failRevoke);
    expect(fake.log).toEqual(["update-password", "invalidate-mfa"]);
    expect(fake.committed).toEqual([]);
  });

  it("invalidates nothing when the target is out of scope", async () => {
    fake.targetRow = [];
    const result = await invoke(lastHandler(usersRouter, "/:id/reset-password"), {
      user: ADMIN, params: { id: TARGET_ID }, body: {}
    });
    expect(result.status).toBe(404);
    expect(fake.log).toEqual([]);
  });
});
