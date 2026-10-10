import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { Request, Response } from "express";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { oidcRouter } from "../oidc.js";
import { createOidcState, sealOidcState } from "../../lib/auth/oidc.js";

// Exercises the real /callback handler, OIDC verification and identities.ts
// SQL against an in-memory fake of the users and user_identities tables.
// Discovery, JWKS and the token endpoint are a faked fetch; ID tokens are
// signed with an RSA key generated for this run.

interface FakeUser {
  id: string;
  email: string;
  role: string;
  programId: string | null;
  isActive: boolean;
}
interface FakeIdentity {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  tenant_id: string | null;
  object_id: string | null;
  last_login_at: string | null;
}

const fake = vi.hoisted(() => ({
  users: [] as Array<{
    id: string; email: string; role: string; programId: string | null; isActive: boolean;
  }>,
  identities: [] as Array<{
    id: string; user_id: string; issuer: string; subject: string;
    tenant_id: string | null; object_id: string | null; last_login_at: string | null;
  }>,
  beforeIdentityInsert: null as null | (() => void),
  userUpdates: [] as Array<Record<string, unknown>>,
  createSession: vi.fn(),
  deleteSessionByToken: vi.fn(),
  setSessionCookie: vi.fn(),
  appendSecurityEvent: vi.fn(),
  recordSecurityEvent: vi.fn(),
  recordSecurityEventBestEffort: vi.fn()
}));

const dialect = new PgDialect();
function render(query: SQL) {
  return dialect.sqlToQuery(query);
}

function executeFake(query: SQL): { rows: unknown[] } {
  const { sql: text, params } = render(query);
  if (text.includes("INSERT INTO user_identities")) {
    fake.beforeIdentityInsert?.();
    const [userId, issuer, subject, tenantId, objectId] = params as Array<string | null>;
    const conflict = fake.identities.some((row) =>
      (row.issuer === issuer && row.subject === subject) ||
      (row.user_id === userId && row.issuer === issuer)
    );
    if (conflict) return { rows: [] };
    const row = {
      id: `identity-${fake.identities.length + 1}`,
      user_id: userId!,
      issuer: issuer!,
      subject: subject!,
      tenant_id: tenantId ?? null,
      object_id: objectId ?? null,
      last_login_at: "now"
    };
    fake.identities.push(row);
    return { rows: [{ id: row.id, user_id: row.user_id }] };
  }
  if (text.includes("FROM user_identities") && text.includes("subject =")) {
    const [issuer, subject] = params;
    const row = fake.identities.find((item) => item.issuer === issuer && item.subject === subject);
    return { rows: row ? [{ id: row.id, user_id: row.user_id }] : [] };
  }
  if (text.includes("FROM user_identities") && text.includes("user_id =")) {
    const [userId, issuer] = params;
    return {
      rows: fake.identities.some((item) => item.user_id === userId && item.issuer === issuer)
        ? [{ found: 1 }]
        : []
    };
  }
  if (text.includes("UPDATE user_identities")) {
    const row = fake.identities.find((item) => item.id === params[0]);
    if (row) row.last_login_at = "touched";
    return { rows: [] };
  }
  if (text.includes("UPDATE sessions")) return { rows: [] };
  throw new Error(`unexpected SQL in test: ${text}`);
}

vi.mock("../../lib/db-client.js", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: async () => {
            const { sql: text, params } = render(condition);
            if (text.includes('"users"."id"')) {
              return fake.users.filter((user) => user.id === params[0]).map((user) => ({ ...user }));
            }
            if (text.includes('"users"."email"')) {
              return fake.users.filter((user) => user.email === params[0]).map((user) => ({ ...user }));
            }
            throw new Error(`unexpected select in test: ${text}`);
          }
        })
      })
    }),
    execute: async (query: SQL) => executeFake(query),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { fake.userUpdates.push(values); }
      })
    }),
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      const snapshot = fake.identities.map((row) => ({ ...row }));
      try {
        return await work(db);
      } catch (error) {
        fake.identities = snapshot;
        throw error;
      }
    }
  };
  return { db };
});
vi.mock("../../lib/auth/sessions.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/sessions.js")>(),
  createSession: fake.createSession,
  deleteSessionByToken: fake.deleteSessionByToken,
  setSessionCookie: fake.setSessionCookie
}));
vi.mock("../../lib/security/audit.js", () => ({
  appendSecurityEvent: fake.appendSecurityEvent,
  recordSecurityEvent: fake.recordSecurityEvent,
  recordSecurityEventBestEffort: fake.recordSecurityEventBestEffort
}));
vi.mock("../../lib/auth/rate-limit.js", () => ({ clientIpFrom: () => "127.0.0.1" }));

const tenant = "11111111-2222-4333-8444-555555555555";
const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
const clientId = "test-client";
const stateSecret = "synthetic-test-state-material-at-least-32-chars";
const allowedProgram = "00000000-0000-4000-8000-0000000000a1";
const otherProgram = "00000000-0000-4000-8000-0000000000b2";
const discovery = {
  issuer,
  authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
  token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
  jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`
};
const person: FakeUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  role: "csr",
  programId: allowedProgram,
  isActive: true
};
const colleague: FakeUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "colleague@example.com",
  role: "csr",
  programId: allowedProgram,
  isActive: true
};

let privateKey: KeyObject;
let publicJwk: Record<string, unknown>;
let idTokenClaims: Record<string, unknown> = {};
let warnSpy: ReturnType<typeof vi.spyOn> | undefined;

function expectCallbackError(message: string) {
  expect(warnSpy).toHaveBeenCalledWith("[oidc] callback failed:", message);
}

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicJwk = { ...pair.publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
});

function signIdToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function jsonResponse(body: unknown) {
  return new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const fetchFake = vi.fn(async (input: unknown) => {
  const url = String(input);
  if (url === `${issuer}/.well-known/openid-configuration`) return jsonResponse(discovery);
  if (url === discovery.jwks_uri) return jsonResponse({ keys: [publicJwk] });
  if (url === discovery.token_endpoint) return jsonResponse({ id_token: signIdToken(idTokenClaims) });
  throw new Error(`unexpected fetch in test: ${url}`);
});

type Handler = (req: Request, res: Response) => Promise<void>;
function callbackHandler(): Handler {
  const stack = (oidcRouter as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const handler = stack.find((layer) => layer.route?.path === "/callback" && layer.route.methods.get)
    ?.route?.stack[0]?.handle;
  expect(handler).toBeDefined();
  return handler!;
}

/** Run one SSO callback whose ID token carries `claims` over the defaults. */
async function callback(claims: Record<string, unknown>) {
  const state = createOidcState("/chat");
  idTokenClaims = {
    iss: issuer,
    aud: clientId,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: state.nonce,
    tid: tenant,
    oid: "object-id-person",
    amr: ["pwd", "mfa"],
    name: "Person Name",
    ...claims
  };
  let location = "";
  const res = {
    clearCookie: vi.fn(),
    cookie: vi.fn(),
    redirect(status: number, url: string) { expect(status).toBe(302); location = url; }
  };
  await callbackHandler()({
    cookies: { truenote_oidc_state: sealOidcState(state, stateSecret) },
    query: { state: state.state, code: "synthetic-auth-code" },
    headers: {}
  } as unknown as Request, res as unknown as Response);
  return { location };
}

function bind(user: FakeUser, subject: string) {
  fake.identities.push({
    id: `identity-${fake.identities.length + 1}`,
    user_id: user.id,
    issuer,
    subject,
    tenant_id: tenant,
    object_id: null,
    last_login_at: null
  });
}

function expectSignedIn(user: FakeUser, location: string) {
  expect(location).toBe("/chat");
  expect(fake.createSession).toHaveBeenCalledTimes(1);
  expect(fake.createSession).toHaveBeenCalledWith(user.id);
  expect(fake.setSessionCookie).toHaveBeenCalledTimes(1);
  expect(fake.recordSecurityEvent).toHaveBeenCalledWith(expect.objectContaining({
    action: "auth.oidc.login",
    outcome: "success",
    actor: { id: user.id, email: user.email, role: user.role }
  }));
}

function expectRefused(location: string, reason?: string) {
  expect(location).toBe("/login?sso_error=1");
  expect(fake.createSession).not.toHaveBeenCalled();
  expect(fake.setSessionCookie).not.toHaveBeenCalled();
  if (reason) {
    expect(fake.recordSecurityEventBestEffort).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.oidc.login",
      outcome: "denied",
      details: { reason, authMethod: "oidc" }
    }));
    const recorded = JSON.stringify(fake.recordSecurityEventBestEffort.mock.calls);
    expect(recorded).not.toContain("synthetic-auth-code");
    expect(recorded).not.toContain(stateSecret);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", fetchFake);
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("OIDC_ISSUER_URL", issuer);
  vi.stubEnv("OIDC_CLIENT_ID", clientId);
  vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-test-value");
  vi.stubEnv("OIDC_REDIRECT_URI", "https://app.example.com/api/auth/oidc/callback");
  vi.stubEnv("OIDC_STATE_SECRET", stateSecret);
  vi.stubEnv("OIDC_TENANT_ID", tenant.toUpperCase());
  vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", allowedProgram);
  vi.stubEnv("OIDC_REQUIRE_MFA", undefined);
  vi.stubEnv("OIDC_REQUIRED_ACR", undefined);
  vi.stubEnv("OIDC_ALLOWED_DOMAINS", undefined);
  fake.users = [{ ...person }, { ...colleague }];
  fake.identities = [];
  fake.beforeIdentityInsert = null;
  fake.userUpdates = [];
  let sessionCount = 0;
  fake.createSession.mockImplementation(async () => ({
    token: `session-token-${++sessionCount}`,
    expiresAt: new Date(Date.now() + 60_000)
  }));
  fake.deleteSessionByToken.mockResolvedValue(undefined);
  fake.appendSecurityEvent.mockResolvedValue({});
  fake.recordSecurityEvent.mockResolvedValue({});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  warnSpy?.mockRestore();
});

describe("OIDC identity binding: first link", () => {
  it("binds an existing active user found by email and records the link", async () => {
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectSignedIn(person, location);
    expect(fake.identities).toEqual([expect.objectContaining({
      user_id: person.id,
      issuer,
      subject: "subject-person",
      tenant_id: tenant,
      object_id: "object-id-person"
    })]);
    expect(fake.appendSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.oidc.identity_linked",
        outcome: "success",
        actor: { id: person.id, email: person.email, role: person.role },
        resourceType: "user_identity",
        resourceId: "identity-1",
        details: { issuer }
      }),
      expect.anything()
    );
  });

  it("refuses an email that matches no Truenote account", async () => {
    const { location } = await callback({ sub: "subject-stranger", email: "stranger@example.com" });
    expectRefused(location, "no_account");
    expect(fake.identities).toEqual([]);
  });

  it("refuses a user already bound to another subject at this issuer", async () => {
    bind(person, "subject-original");
    const { location } = await callback({ sub: "subject-intruder", email: person.email });
    expectRefused(location, "already_bound");
    expect(fake.identities).toHaveLength(1);
    expect(fake.identities[0]!.subject).toBe("subject-original");
  });

  it("refuses when a concurrent login wins the unique constraint", async () => {
    fake.beforeIdentityInsert = () => bind(person, "subject-raced");
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "link_conflict");
    expect(fake.appendSecurityEvent).not.toHaveBeenCalled();
    expect(fake.identities.map((row) => row.subject)).toEqual(["subject-raced"]);
  });

  it.each([false, "false"])("refuses xms_edov %s and writes no binding", async (value) => {
    const { location } = await callback({ sub: "subject-person", email: person.email, xms_edov: value });
    expectRefused(location, "email_domain_unverified");
    expect(fake.identities).toEqual([]);
  });

  it("accepts xms_edov true and an absent xms_edov", async () => {
    expectSignedIn(person, (await callback({ sub: "subject-a", email: person.email, xms_edov: true })).location);
    fake.identities = [];
    vi.clearAllMocks();
    expectSignedIn(person, (await callback({ sub: "subject-b", email: person.email })).location);
  });

  it("refuses a user whose program is not in OIDC_ALLOWED_PROGRAM_IDS", async () => {
    fake.users[0]!.programId = otherProgram;
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "program_not_allowed");
    expect(fake.identities).toEqual([]);
  });

  it("refuses a user with no program", async () => {
    fake.users[0]!.programId = null;
    fake.users[0]!.role = "super_user";
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "program_not_allowed");
    expect(fake.identities).toEqual([]);
  });

  it("refuses an inactive user", async () => {
    fake.users[0]!.isActive = false;
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "inactive");
    expect(fake.identities).toEqual([]);
  });
});

describe("OIDC identity binding: later logins", () => {
  it("finds the user by (issuer, subject) and ignores a changed email claim", async () => {
    bind(person, "subject-person");
    // The directory renamed the account to an address another user owns.
    const { location } = await callback({ sub: "subject-person", email: colleague.email });
    expectSignedIn(person, location);
    expect(fake.createSession).not.toHaveBeenCalledWith(colleague.id);
    expect(fake.identities).toHaveLength(1);
    expect(fake.identities[0]!.last_login_at).toBe("touched");
    expect(fake.appendSecurityEvent).not.toHaveBeenCalled();
  });

  it("signs in with an email claim that matches no account", async () => {
    bind(person, "subject-person");
    const { location } = await callback({ sub: "subject-person", email: "renamed@example.com" });
    expectSignedIn(person, location);
  });

  it("refuses when the program is no longer allowed", async () => {
    bind(person, "subject-person");
    fake.users[0]!.programId = otherProgram;
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "program_not_allowed");
  });

  it("refuses a bound user with no program", async () => {
    bind(person, "subject-person");
    fake.users[0]!.programId = null;
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "program_not_allowed");
  });

  it("refuses a bound user who was deactivated", async () => {
    bind(person, "subject-person");
    fake.users[0]!.isActive = false;
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location, "inactive");
  });
});

describe("OIDC token checks for binding", () => {
  it("refuses a token from another tenant", async () => {
    const { location } = await callback({
      sub: "subject-person",
      email: person.email,
      tid: "99999999-2222-4333-8444-555555555555"
    });
    expectRefused(location);
    expectCallbackError("OIDC tenant mismatch");
    expect(fake.identities).toEqual([]);
  });

  it("refuses a token with no tid when OIDC_TENANT_ID is set", async () => {
    const { location } = await callback({ sub: "subject-person", email: person.email, tid: undefined });
    expectRefused(location);
    expectCallbackError("OIDC tenant mismatch");
  });

  it.each([undefined, "", 42])("refuses a token whose sub is %s", async (sub) => {
    const { location } = await callback({ sub, email: person.email });
    expectRefused(location);
    expectCallbackError("OIDC id_token has no subject");
    expect(fake.identities).toEqual([]);
  });

  it.each([
    ["OIDC_TENANT_ID unset", "OIDC_TENANT_ID", undefined],
    ["OIDC_TENANT_ID for another tenant", "OIDC_TENANT_ID", "99999999-2222-4333-8444-555555555555"],
    ["no allowed programs", "OIDC_ALLOWED_PROGRAM_IDS", ""]
  ])("refuses every callback with %s", async (_label, name, value) => {
    bind(person, "subject-person");
    vi.stubEnv(name, value);
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expectRefused(location);
    expectCallbackError("OIDC is not fully configured");
  });

  it("deletes the new session when a later step fails", async () => {
    bind(person, "subject-person");
    fake.recordSecurityEvent.mockRejectedValueOnce(new Error("audit unavailable"));
    const { location } = await callback({ sub: "subject-person", email: person.email });
    expect(location).toBe("/login?sso_error=1");
    expectCallbackError("audit unavailable");
    expect(fake.deleteSessionByToken).toHaveBeenCalledWith("session-token-1");
    expect(fake.setSessionCookie).not.toHaveBeenCalled();
  });
});
