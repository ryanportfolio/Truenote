import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRouter } from "../auth.js";
import { sessions } from "@workspace/db/schema";
import { hashToken, SESSION_COOKIE_NAME } from "../../lib/auth/sessions.js";

const fake = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  insert: vi.fn(),
  values: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  audit: vi.fn(),
  updateRows: [] as unknown[]
}));

vi.mock("../../lib/db-client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => fake.rows }) }) }),
    insert: fake.insert,
    update: () => ({
      set: () => ({
        where: () => Object.assign(Promise.resolve(undefined), {
          returning: async () => fake.updateRows
        })
      })
    })
  }
}));
vi.mock("../../lib/auth/passwords.js", () => ({
  verifyPassword: fake.verifyPassword,
  hashPassword: fake.hashPassword
}));
vi.mock("../../lib/security/audit.js", () => ({ recordSecurityEventBestEffort: fake.audit }));
vi.mock("../../lib/auth/rate-limit.js", () => ({
  clientIpFrom: () => "127.0.0.1",
  loginIpLimiter: { hit: () => true },
  forgotPasswordEmailLimiter: { hit: () => true },
  forgotPasswordIpLimiter: { hit: () => true }
}));

const oidcVariables = [
  "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET", "LOCAL_LOGIN_MODE",
  "OIDC_TENANT_ID", "OIDC_ALLOWED_PROGRAM_IDS"
];
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  role: "csr",
  passwordHash: "stored-password-hash",
  programId: null,
  name: "Person",
  isActive: true,
  mustResetPassword: false
};

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

// Invoke the mounted Express login handler, retaining the real OIDC config,
// session creation and cookie helper. Only persistence/password work is faked.
async function login() {
  type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
  const stack = (authRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const handler = stack.find((layer) => layer.route?.path === "/login" && layer.route.methods.post)?.route?.stack[0]?.handle;
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
  await handler!({ body: { email: user.email, password: "supplied-password" } } as Request,
    response as unknown as Response, next);
  expect(next).not.toHaveBeenCalled();
  return { status, body, cookie };
}

beforeEach(() => {
  vi.clearAllMocks();
  oidcVariables.forEach((name) => vi.stubEnv(name, undefined));
  vi.stubEnv("NODE_ENV", "production");
  fake.rows = [{ ...user }];
  fake.verifyPassword.mockResolvedValue(true);
  fake.hashPassword.mockResolvedValue("dummy-password-hash");
  fake.insert.mockReturnValue({ values: fake.values });
  fake.values.mockResolvedValue(undefined);
  fake.updateRows = [{ failedLoginCount: 1, lockedUntil: null }];
});
afterEach(() => vi.unstubAllEnvs());

// A policy-refused account gets the generic credential failure, and its
// stored hash is never verified, so the response cannot confirm a correct
// password. The refusal is audited without password data.
async function expectDenied() {
  const result = await login();
  expect.soft(result.status).toBe(401);
  expect.soft(result.body).toEqual({ error: "Invalid credentials" });
  expect.soft(result.cookie).not.toHaveBeenCalled();
  expect.soft(fake.insert).not.toHaveBeenCalled();
  expect.soft(fake.audit).toHaveBeenCalledTimes(1);
  expect.soft(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
    action: "auth.local.login",
    outcome: "denied",
    details: expect.objectContaining({ reason: "local_login_mode" })
  }));
  expect.soft(JSON.stringify(fake.audit.mock.calls)).not.toContain("supplied-password");
  expect(fake.verifyPassword).toHaveBeenCalledTimes(1);
  expect(fake.verifyPassword).toHaveBeenCalledWith("supplied-password", "dummy-password-hash");
  expect(fake.verifyPassword).not.toHaveBeenCalledWith(expect.anything(), user.passwordHash);
}

async function expectSession(action: string) {
  const result = await login();
  expect(result.status).toBe(200);
  expect(fake.insert).toHaveBeenCalledTimes(1);
  expect(fake.insert).toHaveBeenCalledWith(sessions);
  expect(result.cookie).toHaveBeenCalledTimes(1);
  const [name, token, options] = result.cookie.mock.calls[0]!;
  expect(name).toBe(SESSION_COOKIE_NAME);
  expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  expect(fake.values).toHaveBeenCalledTimes(1);
  expect(fake.values).toHaveBeenCalledWith({
    userId: user.id, tokenHash: hashToken(token), expiresAt: expect.any(Date)
  });
  expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action, outcome: "success" }));
}

describe.each(["unset", "partial", "invalid-url", "short-state-secret", "valid"])("local login with %s OIDC", (state) => {
  beforeEach(() => configureOidc(state));

  it.each(["csr", "super_user"])("disabled denies %s without a session or cookie", async (role) => {
    fake.rows[0]!.role = role;
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    await expectDenied();
  });

  it.each(["csr", "supervisor", "manager"])("break_glass denies %s", async (role) => {
    fake.rows[0]!.role = role;
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    await expectDenied();
  });

  it("break_glass permits and audits a super_user", async () => {
    fake.rows[0]!.role = "super_user";
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    await expectSession("auth.break_glass.login");
  });

  it("explicit enabled permits normal local login", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    await expectSession("auth.local.login");
  });
});

describe("local login defaults", () => {
  it("keeps entirely unset local/test operation usable", async () => {
    await expectSession("auth.local.login");
  });

  it.each(["partial", "invalid-url", "short-state-secret"])("fails closed for %s OIDC without an explicit policy", async (state) => {
    configureOidc(state);
    fake.rows[0]!.role = "super_user";
    await expectDenied();
  });

  it.each(["unset", "partial", "valid"])("fails closed for an invalid policy with %s OIDC", async (state) => {
    configureOidc(state);
    vi.stubEnv("LOCAL_LOGIN_MODE", "disable");
    fake.rows[0]!.role = "super_user";
    await expectDenied();
  });

  it("retains the break_glass default for valid configured SSO", async () => {
    configureOidc("valid");
    await expectDenied();
    fake.verifyPassword.mockClear();
    fake.rows[0]!.role = "super_user";
    await expectSession("auth.break_glass.login");
  });
});

describe("credential failures remain indistinguishable", () => {
  // In "disabled" the existing account is policy-refused before its hash is
  // read, so even the wrong-password case verifies the dummy hash.
  it.each([
    ["enabled", "missing"], ["enabled", "inactive"], ["enabled", "wrong-password"],
    ["disabled", "missing"], ["disabled", "inactive"]
  ])("in %s mode verifies a password and returns generic 401 for %s", async (mode, failure) => {
    vi.stubEnv("LOCAL_LOGIN_MODE", mode);
    if (failure === "missing") fake.rows = [];
    if (failure === "inactive") fake.rows[0]!.isActive = false;
    fake.verifyPassword.mockResolvedValue(false);
    const result = await login();
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "Invalid credentials" });
    expect(fake.verifyPassword).toHaveBeenCalledTimes(1);
    expect(fake.verifyPassword).toHaveBeenCalledWith(
      "supplied-password", failure === "wrong-password" ? user.passwordHash : "dummy-password-hash"
    );
    expect(fake.insert).not.toHaveBeenCalled();
    expect(result.cookie).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });
});

describe("policy refusal does not reveal a correct password", () => {
  it.each([
    ["break_glass", "csr"], ["break_glass", "manager"], ["disabled", "csr"], ["disabled", "super_user"]
  ])("in %s a %s gets the same response for correct and wrong passwords", async (mode, role) => {
    vi.stubEnv("LOCAL_LOGIN_MODE", mode);
    fake.rows[0]!.role = role;
    fake.verifyPassword.mockResolvedValue(true);
    const correct = await login();
    fake.verifyPassword.mockResolvedValue(false);
    const wrong = await login();
    expect(correct.status).toBe(401);
    expect({ status: correct.status, body: correct.body })
      .toEqual({ status: wrong.status, body: wrong.body });
    expect(fake.verifyPassword).toHaveBeenCalledTimes(2);
    expect(fake.verifyPassword).not.toHaveBeenCalledWith(expect.anything(), user.passwordHash);
    expect(fake.insert).not.toHaveBeenCalled();
  });
});
