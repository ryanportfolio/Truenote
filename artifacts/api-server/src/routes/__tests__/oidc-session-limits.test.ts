import type { Request, Response } from "express";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs the real /callback handler for an already-bound SSO user, with the
// OIDC protocol steps (state, discovery, token verification) and the
// database faked, to check the expiry written to the session row and the
// cookie lifetime that goes with it. The real setSessionCookie runs.

const fake = vi.hoisted(() => ({
  executed: [] as SQL[],
  createSession: vi.fn(),
  deleteSessionByToken: vi.fn()
}));

const programId = "00000000-0000-4000-8000-0000000000a1";
const user = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  role: "csr",
  programId,
  isActive: true
};

vi.mock("../../lib/db-client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [{ ...user }] }) })
    }),
    execute: async (query: SQL) => {
      fake.executed.push(query);
      return { rows: [] };
    },
    update: () => ({ set: () => ({ where: async () => undefined }) })
  }
}));
vi.mock("../../lib/auth/oidc.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/oidc.js")>(),
  getOidcConfig: () => ({
    enabled: true,
    stateSecret: "synthetic-test-state-material-at-least-32-chars",
    redirectUri: "https://app.example.com/api/auth/oidc/callback",
    clientId: "test-client",
    clientSecret: "synthetic-test-value",
    allowedProgramIds: [programId],
    localLoginMode: "break_glass"
  }),
  openOidcState: () => ({
    state: "synthetic-state",
    nonce: "synthetic-nonce",
    codeVerifier: "synthetic-verifier",
    returnTo: "/chat",
    expiresAt: Date.now() + 60_000
  }),
  loadOidcDiscovery: async () => ({
    issuer: "https://issuer.example.com",
    authorization_endpoint: "https://issuer.example.com/authorize",
    token_endpoint: "https://issuer.example.com/token",
    jwks_uri: "https://issuer.example.com/keys"
  }),
  verifyOidcIdToken: async () => ({
    claims: {},
    subject: "subject-person",
    tenantId: null,
    objectId: null,
    email: user.email,
    name: null
  })
}));
vi.mock("../../lib/auth/identities.js", () => ({
  findIdentityBySubject: async () => ({ id: "identity-1", userId: user.id }),
  recordIdentityLogin: async () => undefined,
  linkIdentity: async () => null,
  userHasIdentityForIssuer: async () => false
}));
vi.mock("../../lib/auth/sessions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/sessions.js")>(),
  createSession: fake.createSession,
  deleteSessionByToken: fake.deleteSessionByToken
}));
vi.mock("../../lib/security/audit.js", () => ({
  appendSecurityEvent: vi.fn(async () => ({})),
  recordSecurityEvent: vi.fn(async () => ({})),
  recordSecurityEventBestEffort: vi.fn()
}));
vi.mock("../../lib/auth/rate-limit.js", () => ({ clientIpFrom: () => "127.0.0.1" }));

import { oidcRouter } from "../oidc.js";
import { SESSION_COOKIE_NAME } from "../../lib/auth/sessions.js";

type Handler = (req: Request, res: Response) => Promise<void>;
function callbackHandler(): Handler {
  const stack = (oidcRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const handler = stack.find((layer) => layer.route?.path === "/callback" && layer.route.methods.get)
    ?.route?.stack.at(-1)?.handle;
  expect(handler).toBeDefined();
  return handler!;
}

async function callback() {
  const cookie = vi.fn();
  let location = "";
  const res = {
    clearCookie: vi.fn(),
    cookie,
    redirect(_status: number, url: string) { location = url; }
  };
  await callbackHandler()({
    cookies: { truenote_oidc_state: "sealed" },
    query: { state: "synthetic-state", code: "synthetic-auth-code" },
    headers: {}
  } as unknown as Request, res as unknown as Response);
  return { cookie, location };
}

function sessionUpdate() {
  const dialect = new PgDialect();
  const rendered = fake.executed
    .map((query) => dialect.sqlToQuery(query))
    .filter((query) => query.sql.includes("UPDATE sessions"));
  expect(rendered).toHaveLength(1);
  return rendered[0]!;
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  fake.executed = [];
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("SSO_SESSION_MAX_HOURS", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => new globalThis.Response(
    JSON.stringify({ id_token: "synthetic-id-token" }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )));
  fake.createSession.mockResolvedValue({
    token: "session-token-1",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });
  fake.deleteSessionByToken.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warnSpy.mockRestore();
});

describe("SSO session absolute limit", () => {
  it("expires an oidc session 10 hours after sign-in and matches the cookie", async () => {
    const { cookie, location } = await callback();
    expect(location).toBe("/chat");
    expect(fake.createSession).toHaveBeenCalledWith(user.id);

    const update = sessionUpdate();
    expect(update.sql).toMatch(/auth_method = 'oidc'/);
    expect(update.sql).toMatch(/expires_at = now\(\) \+ make_interval\(hours => \$1::int\)/);
    expect(update.params[0]).toBe(10);

    expect(cookie).toHaveBeenCalledTimes(1);
    expect(cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      "session-token-1",
      expect.objectContaining({ maxAge: 10 * 60 * 60 * 1000, httpOnly: true })
    );
  });

  it("follows SSO_SESSION_MAX_HOURS for both the row and the cookie", async () => {
    vi.stubEnv("SSO_SESSION_MAX_HOURS", "4");
    const { cookie } = await callback();
    expect(sessionUpdate().params[0]).toBe(4);
    expect(cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      "session-token-1",
      expect.objectContaining({ maxAge: 4 * 60 * 60 * 1000 })
    );
  });

  it("uses the default for an out-of-range SSO_SESSION_MAX_HOURS", async () => {
    vi.stubEnv("SSO_SESSION_MAX_HOURS", "72");
    const { cookie } = await callback();
    expect(sessionUpdate().params[0]).toBe(10);
    expect(cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      "session-token-1",
      expect.objectContaining({ maxAge: 10 * 60 * 60 * 1000 })
    );
  });
});
