import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { passwordResetTokens, sessions, users } from "@workspace/db/schema";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { authRouter } from "../auth.js";
import { hashToken, SESSION_COOKIE_NAME } from "../../lib/auth/sessions.js";

const fake = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  lookupResetTokenUserId: vi.fn(),
  hashPassword: vi.fn(),
  transaction: vi.fn(),
  consume: vi.fn(),
  passwordUpdate: vi.fn(),
  revoke: vi.fn(),
  insert: vi.fn(),
  committed: [] as string[],
  consumeAllowed: true,
  insertError: null as Error | null,
  // Rows of user_passkeys for the reset user, read inside the transaction.
  passkeys: [] as Array<Record<string, unknown>>,
  passkeyQuery: vi.fn(),
  audit: vi.fn(),
  // The pending-MFA invalidation, run on the transaction's executor and
  // committed only with the rest of the transaction.
  mfaInvalidate: vi.fn(),
  mfaCommitted: [] as string[]
}));

vi.mock("../../lib/db-client.js", () => ({ db: { transaction: fake.transaction } }));
vi.mock("../../lib/security/audit.js", () => ({ recordSecurityEventBestEffort: fake.audit }));
vi.mock("../../lib/auth/passwords.js", () => ({
  hashPassword: fake.hashPassword,
  verifyPassword: vi.fn()
}));
vi.mock("../../lib/auth/password-reset.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/password-reset.js")>(),
  lookupResetTokenUserId: fake.lookupResetTokenUserId
}));

const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  role: "csr",
  programId: null,
  name: "Person",
  isActive: true
};
const resetToken = "synthetic_reset_token_at_least_16_chars";
const newPassword = "synthetic-new-password-long-enough-for-policy";
const envNames = [
  "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET", "LOCAL_LOGIN_MODE", "DEMO_LOGIN_ACCOUNTS",
  "OIDC_TENANT_ID", "OIDC_ALLOWED_PROGRAM_IDS"
];

function configureOidc(state: string) {
  if (state === "unset") return;
  vi.stubEnv("OIDC_ISSUER_URL", "https://idp.example.com");
  if (state === "partial") return;
  vi.stubEnv("OIDC_CLIENT_ID", "test-client");
  vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-test-value");
  vi.stubEnv("OIDC_REDIRECT_URI", "https://app.example.com/api/auth/oidc/callback");
  vi.stubEnv("OIDC_STATE_SECRET", "synthetic-test-state-material-at-least-32-chars");
  vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", "00000000-0000-4000-8000-0000000000a1");
  if (state === "invalid-url") vi.stubEnv("OIDC_ISSUER_URL", "not-a-url");
  if (state === "short-state-secret") vi.stubEnv("OIDC_STATE_SECRET", "short");
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
function route(path: string) {
  const stack = (authRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const found = stack.find((layer) => layer.route?.path === path && layer.route.methods.post)?.route;
  expect(found).toBeDefined();
  return found!;
}

async function invokeFirstHandler(path = "/reset-password") {
  let status = 200;
  let body: unknown;
  const cookie = vi.fn();
  const response = {
    status(code: number) { status = code; return response; },
    json(value: unknown) { body = value; return response; },
    cookie
  };
  const next = vi.fn();
  await route(path).stack[0]!.handle(
    { body: { token: resetToken, newPassword }, user: null, ip: "203.0.113.7", header: () => undefined } as unknown as Request,
    response as unknown as Response, next
  );
  return { status, body, cookie, next };
}

beforeEach(() => {
  vi.clearAllMocks();
  envNames.forEach((name) => vi.stubEnv(name, undefined));
  vi.stubEnv("NODE_ENV", "production");
  fake.rows = [{ ...user }];
  fake.committed = [];
  fake.consumeAllowed = true;
  fake.insertError = null;
  fake.passkeys = [];
  fake.mfaCommitted = [];
  fake.lookupResetTokenUserId.mockResolvedValue(user.id);
  fake.hashPassword.mockResolvedValue("new-password-hash");
  // Model transaction commit only after callback success; rejected callbacks
  // discard every pending write, including token consumption.
  fake.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const pending: string[] = [];
    const pendingMfa: string[] = [];
    const tx = {
      update: (table: unknown) => ({ set: (values: unknown) => ({ where: (condition: unknown) => {
        if (table === passwordResetTokens) return { returning: async () => {
          fake.consume(values, condition);
          if (!fake.consumeAllowed) return [];
          pending.push("consume-token");
          return [{ userId: user.id }];
        } };
        expect(table).toBe(users);
        fake.passwordUpdate(values, condition);
        pending.push("update-password");
        return Promise.resolve();
      } }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => fake.rows }) }) }),
      delete: (table: unknown) => ({ where: async (condition: unknown) => {
        expect(table).toBe(sessions);
        fake.revoke(condition);
        pending.push("revoke-sessions");
      } }),
      insert: (table: unknown) => ({ values: async (values: unknown) => {
        expect(table).toBe(sessions);
        fake.insert(values);
        if (fake.insertError) throw fake.insertError;
        pending.push("insert-session");
      } }),
      execute: async (query: SQL) => {
        const { sql: text, params } = new PgDialect().sqlToQuery(query);
        const compact = text.replace(/\s+/g, " ").trim();
        if (compact.startsWith("DELETE FROM mfa_challenges")) {
          fake.mfaInvalidate(compact, params, [...pending]);
          pendingMfa.push("invalidate-mfa-challenges");
          return { rows: [] };
        }
        fake.passkeyQuery(compact, params);
        return { rows: fake.passkeys.filter((row) => row.user_id === params[0]) };
      }
    };
    const result = await callback(tx);
    fake.committed.push(...pending);
    fake.mfaCommitted.push(...pendingMfa);
    return result;
  });
});
afterEach(() => vi.unstubAllEnvs());

async function expectDenied(status = 403, error = "Use company SSO to sign in.") {
  const result = await invokeFirstHandler();
  expect.soft(result.status).toBe(status);
  expect.soft(result.body).toEqual({ error });
  expect.soft(result.cookie).not.toHaveBeenCalled();
  expect.soft(fake.committed).toEqual([]);
  expect.soft(fake.passwordUpdate).not.toHaveBeenCalled();
  expect.soft(fake.revoke).not.toHaveBeenCalled();
  expect.soft(fake.insert).not.toHaveBeenCalled();
  expect.soft(fake.mfaCommitted).toEqual([]);
  expect(result.next).not.toHaveBeenCalled();
}

// Finding: a pending MFA login started with the old password must not
// survive the reset. Every unconsumed challenge of the user is deleted on the
// transaction's executor (the db mock has no execute), right after the
// password write, and commits with it.
function expectMfaInvalidatedInTransaction() {
  expect(fake.mfaInvalidate).toHaveBeenCalledTimes(1);
  const [text, params, writtenBefore] = fake.mfaInvalidate.mock.calls[0]!;
  expect(text).toBe("DELETE FROM mfa_challenges WHERE user_id = $1::uuid AND consumed_at IS NULL");
  expect(params).toEqual([user.id]);
  expect(writtenBefore).toEqual(["consume-token", "update-password"]);
  expect(fake.mfaCommitted).toEqual(["invalidate-mfa-challenges"]);
}

async function expectSuccess() {
  const result = await invokeFirstHandler();
  expect(result.next).not.toHaveBeenCalled();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ user: {
    id: user.id, email: user.email, name: user.name,
    role: fake.rows[0]!.role, programId: null, mustResetPassword: false
  } });
  expect(fake.committed).toEqual(["consume-token", "update-password", "revoke-sessions", "insert-session"]);
  expect(fake.lookupResetTokenUserId).toHaveBeenCalledWith(resetToken);
  expect(fake.hashPassword).toHaveBeenCalledWith(newPassword);
  expect(fake.passwordUpdate).toHaveBeenCalledWith(
    { passwordHash: "new-password-hash", mustResetPassword: false }, expect.anything()
  );
  expect(result.cookie).toHaveBeenCalledTimes(1);
  const [name, token, options] = result.cookie.mock.calls[0]!;
  expect(name).toBe(SESSION_COOKIE_NAME);
  expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  expect(fake.insert).toHaveBeenCalledWith({ userId: user.id, tokenHash: hashToken(token), expiresAt: expect.any(Date) });
  // Keep the real atomic consume predicate: token hash, expiry, and unused.
  const condition = new PgDialect().sqlToQuery(fake.consume.mock.calls[0]![1]);
  expect(condition.sql).toContain('"password_reset_tokens"."token_hash" =');
  expect(condition.sql).toContain('"password_reset_tokens"."expires_at" >');
  expect(condition.sql).toContain('"password_reset_tokens"."used_at" is null');
  expectPasskeyCheckedInTransaction();
  expectMfaInvalidatedInTransaction();
  expect(fake.audit).not.toHaveBeenCalled();
}

function expectPasskeyCheckedInTransaction() {
  expect(fake.passkeyQuery).toHaveBeenCalledTimes(1);
  const [text, params] = fake.passkeyQuery.mock.calls[0]!;
  expect(text).toMatch(/FROM user_passkeys WHERE user_id = \$1::uuid/);
  expect(params).toEqual([user.id]);
}

function enrollPasskey() {
  fake.passkeys.push({
    id: "00000000-0000-4000-8000-0000000000c1", user_id: user.id,
    credential_id: "c3ludGhldGljLWNyZWRlbnRpYWw", public_key: new Uint8Array([1, 2, 3]),
    sign_count: 0, transports: ["internal"], name: "Laptop",
    created_at: new Date(), last_used_at: null
  });
}

// The password changes, the link is consumed and old sessions are revoked,
// but no session is issued: the user signs in through /login and its MFA step.
async function expectSignInRequired(reason: "second_factor_required" | "break_glass_mfa_missing") {
  const result = await invokeFirstHandler();
  expect(result.next).not.toHaveBeenCalled();
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ passwordReset: true, signInRequired: true });
  expect(result.cookie).not.toHaveBeenCalled();
  expect(fake.insert).not.toHaveBeenCalled();
  expect(fake.committed).toEqual(["consume-token", "update-password", "revoke-sessions"]);
  expect(fake.passwordUpdate).toHaveBeenCalledWith(
    { passwordHash: "new-password-hash", mustResetPassword: false }, expect.anything()
  );
  expect(fake.revoke).toHaveBeenCalledTimes(1);
  const condition = new PgDialect().sqlToQuery(fake.consume.mock.calls[0]![1]);
  expect(condition.sql).toContain('"password_reset_tokens"."used_at" is null');
  expectPasskeyCheckedInTransaction();
  expectMfaInvalidatedInTransaction();
  expect(fake.audit).toHaveBeenCalledTimes(1);
  expect(fake.audit).toHaveBeenCalledWith({
    action: "auth.password_reset.sign_in_required",
    outcome: "success",
    actor: { id: user.id, email: user.email, role: fake.rows[0]!.role },
    programId: null,
    resourceType: "user",
    resourceId: user.id,
    sourceIp: "203.0.113.7",
    details: { authMethod: "local", reason }
  });
}

describe.each(["unset", "partial", "invalid-url", "short-state-secret", "valid"])("reset/invite completion with %s OIDC", (state) => {
  beforeEach(() => configureOidc(state));
  it.each(["csr", "super_user"])("disabled rejects %s and rolls back all writes", async (role) => {
    fake.rows[0]!.role = role;
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    await expectDenied();
  });
  it.each(["csr", "supervisor", "manager", "senior_manager"])("break_glass rejects %s and rolls back all writes", async (role) => {
    fake.rows[0]!.role = role;
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    await expectDenied();
  });
  // Contract item 7: in break_glass mode a super_user with no passkey gets no
  // session from /login, so a reset link must not issue one either. This
  // case used to assert auto-login; it now asserts the password still resets
  // and the user must sign in again.
  it("break_glass resets a super_user without a passkey but requires sign-in", async () => {
    fake.rows[0]!.role = "super_user";
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    await expectSignInRequired("break_glass_mfa_missing");
  });
  it("break_glass resets a super_user with a passkey but requires sign-in", async () => {
    fake.rows[0]!.role = "super_user";
    enrollPasskey();
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    await expectSignInRequired("second_factor_required");
  });
  it("explicit enabled preserves atomic reset and auto-login", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    await expectSuccess();
  });
  it.each(["csr", "super_user"])("enabled resets %s with a passkey but requires sign-in", async (role) => {
    fake.rows[0]!.role = role;
    enrollPasskey();
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    await expectSignInRequired("second_factor_required");
  });
  it("enabled still auto-logs-in a super_user without a passkey", async () => {
    fake.rows[0]!.role = "super_user";
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    await expectSuccess();
  });
});

describe("reset policy defaults and rejected links", () => {
  it("preserves entirely unset testing setup", expectSuccess);
  it.each(["partial", "invalid-url", "short-state-secret"])("fails closed for %s OIDC without explicit policy", async (state) => {
    configureOidc(state);
    fake.rows[0]!.role = "super_user";
    await expectDenied();
  });
  it.each(["unset", "partial", "valid"])("fails closed for invalid policy with %s OIDC", async (state) => {
    configureOidc(state);
    vi.stubEnv("LOCAL_LOGIN_MODE", "disable");
    await expectDenied();
  });
  // The super_user branch used to assert auto-login; under the break_glass
  // default it now requires sign-in (contract item 7, see above).
  it.each(["csr", "super_user"])("valid OIDC defaults to break_glass for %s", async (role) => {
    configureOidc("valid");
    fake.rows[0]!.role = role;
    if (role === "super_user") await expectSignInRequired("break_glass_mfa_missing");
    else await expectDenied();
  });
  it("preserves entirely unset testing setup for a user with a passkey by requiring sign-in", async () => {
    enrollPasskey();
    await expectSignInRequired("second_factor_required");
  });
  it("policy denial rolls back before the passkey check and records no reset event", async () => {
    enrollPasskey();
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    await expectDenied();
    expect(fake.passkeyQuery).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });
  it("rolls back all writes if the passkey check fails", async () => {
    const failure = new Error("synthetic passkey lookup failure");
    fake.passkeyQuery.mockImplementationOnce(() => { throw failure; });
    const result = await invokeFirstHandler();
    expect(fake.committed).toEqual([]);
    expect(result.cookie).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
    expect(result.next).toHaveBeenCalledWith(failure);
    // The invalidation ran in the transaction and rolled back with it.
    expect(fake.mfaInvalidate).toHaveBeenCalledTimes(1);
    expect(fake.mfaCommitted).toEqual([]);
  });
  it.each(["bad", "used", "expired"])("rejects %s token at preflight", async () => {
    fake.lookupResetTokenUserId.mockResolvedValue(null);
    await expectDenied(400, "This reset link is invalid or has expired");
    expect(fake.transaction).not.toHaveBeenCalled();
    expect(fake.hashPassword).not.toHaveBeenCalled();
  });
  it.each(["used", "expired"])("rejects token that became %s after preflight", async () => {
    fake.consumeAllowed = false;
    await expectDenied(400, "This reset link is invalid or has expired");
  });
  it.each(["missing", "inactive", "demo"])("rejects %s account without committing writes", async (state) => {
    if (state === "missing") fake.rows = [];
    if (state === "inactive") fake.rows[0]!.isActive = false;
    if (state === "demo") vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "Demo", email: user.email, password: "published-test-password" }
    ]));
    await expectDenied(400, "This reset link is invalid or has expired");
  });
  it("rolls back all writes and sends no cookie if session insertion fails", async () => {
    fake.insertError = new Error("synthetic insertion failure");
    const result = await invokeFirstHandler();
    expect(fake.committed).toEqual([]);
    expect(result.cookie).not.toHaveBeenCalled();
    expect(result.next).toHaveBeenCalledWith(fake.insertError);
    expect(fake.mfaInvalidate).toHaveBeenCalledTimes(1);
    expect(fake.mfaCommitted).toEqual([]);
  });
  it("change-password rejects unauthenticated callers before password or transaction work", async () => {
    const result = await invokeFirstHandler("/change-password");
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "Unauthorized" });
    expect(result.next).not.toHaveBeenCalled();
    expect(fake.transaction).not.toHaveBeenCalled();
    expect(fake.hashPassword).not.toHaveBeenCalled();
    expect(result.cookie).not.toHaveBeenCalled();
  });
});
