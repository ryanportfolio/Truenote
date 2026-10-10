import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { passwordResetTokens } from "@workspace/db/schema";

// Break-glass second factor, end to end over HTTP: the real auth and MFA
// routers, lib/auth/mfa.ts, recovery-codes.ts, webauthn-config.ts and
// sessions.ts. Faked: the database (an in-memory model of the three MFA
// tables, keyed on the SQL text mfa.ts and recovery-codes.ts send), password
// hashing, the audit log, the lockout writes (spied; lockout.test.ts covers
// the counting) and the two WebAuthn signature checks of @simplewebauthn/server.

interface ChallengeRow {
  id: string;
  user_id: string;
  purpose: "login" | "register";
  challenge: string;
  token_hash: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}
interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  sign_count: number;
  transports: string[] | null;
  name: string | null;
  created_at: Date;
  last_used_at: Date | null;
}
interface CodeRow {
  id: string;
  user_id: string;
  code_hash: string;
  used_at: number | null;
}
interface Tables {
  challenges: ChallengeRow[];
  passkeys: PasskeyRow[];
  codes: CodeRow[];
}

const fake = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  tables: { challenges: [], passkeys: [], codes: [] } as unknown as Tables,
  clockOffset: 0,
  nextId: 1,
  sessionInsert: vi.fn(),
  verifyPassword: vi.fn(),
  audit: vi.fn(),
  recordAuthFailure: vi.fn(),
  recordAuthSuccess: vi.fn(),
  verifyAuthentication: vi.fn(),
  verifyRegistration: vi.fn(),
  sql: [] as string[],
  // Row locks taken by SELECT ... FOR UPDATE, keyed on the first parameter
  // (the user id) and held until the transaction ends.
  rowLocks: new Map<string, Promise<void>>(),
  // For each appendSecurityEvent call: did it run on a transaction executor?
  auditInTx: [] as boolean[],
  appendFailure: null as Error | null,
  // Drizzle builder writes made inside a transaction (reset-password).
  txWrites: [] as string[],
  // Every statement and session insert run on a transaction executor,
  // tagged with the transaction it ran in.
  txLog: [] as Array<{ tx: number; op: string }>,
  txCounter: 0,
  // When set, a session insert inside a transaction throws it.
  sessionInsertFailure: null as Error | null,
  // When set, runs once as the next transaction starts, before its first
  // statement: a write another connection commits after the request's
  // unlocked reads and before its locking transaction.
  beforeNextTransaction: null as (() => void) | null
}));

function now() {
  return Date.now() + fake.clockOffset;
}
function newId() {
  return `00000000-0000-4000-8000-${String(fake.nextId++).padStart(12, "0")}`;
}

const dialect = new PgDialect();

function runSql(query: SQL): { rows: unknown[] } {
  const { sql: raw, params } = dialect.sqlToQuery(query);
  const text = raw.replace(/\s+/g, " ").trim();
  fake.sql.push(text);
  const p = params as unknown[];
  const t = fake.tables;

  if (text.startsWith("SELECT id::text AS id, user_id::text AS user_id, credential_id")) {
    const rows = t.passkeys.filter((r) => r.user_id === p[0] && (p.length < 2 || r.credential_id === p[1]));
    return { rows: rows.map((r) => ({ ...r })) };
  }
  if (text.startsWith("INSERT INTO mfa_challenges (user_id, purpose, challenge, token_hash, expires_at)")) {
    t.challenges.push({
      id: newId(), user_id: p[0] as string, purpose: "login", challenge: p[1] as string,
      token_hash: p[2] as string, expires_at: now() + (p[3] as number) * 1000,
      consumed_at: null, created_at: now()
    });
    return { rows: [] };
  }
  if (text.startsWith("INSERT INTO mfa_challenges (user_id, purpose, challenge, expires_at)")) {
    t.challenges.push({
      id: newId(), user_id: p[0] as string, purpose: "register", challenge: p[1] as string,
      token_hash: null, expires_at: now() + (p[2] as number) * 1000,
      consumed_at: null, created_at: now()
    });
    return { rows: [] };
  }
  if (text.startsWith("SELECT id::text AS id, user_id::text AS user_id, challenge FROM mfa_challenges")) {
    const login = text.includes("WHERE token_hash =");
    const rows = t.challenges
      .filter((r) => (login ? r.token_hash === p[0] && r.purpose === "login" : r.user_id === p[0] && r.purpose === "register"))
      .filter((r) => r.consumed_at === null && r.expires_at > now())
      .sort((a, b) => b.created_at - a.created_at);
    return { rows: rows.slice(0, 1).map((r) => ({ id: r.id, user_id: r.user_id, challenge: r.challenge })) };
  }
  if (text.startsWith("UPDATE mfa_challenges SET consumed_at = now()")) {
    const row = t.challenges.find((r) => r.id === p[0] && r.consumed_at === null && r.expires_at > now());
    if (!row) return { rows: [] };
    row.consumed_at = now();
    return { rows: [{ id: row.id }] };
  }
  if (text.startsWith("UPDATE user_passkeys SET sign_count")) {
    const row = t.passkeys.find((r) => r.id === p[1]);
    if (row) {
      row.sign_count = p[0] as number;
      row.last_used_at = new Date(now());
    }
    return { rows: [] };
  }
  if (text.startsWith("INSERT INTO user_passkeys")) {
    if (t.passkeys.some((r) => r.credential_id === p[1])) return { rows: [] };
    const csv = p[4] as string;
    const row: PasskeyRow = {
      id: newId(), user_id: p[0] as string, credential_id: p[1] as string,
      public_key: new Uint8Array(p[2] as Buffer), sign_count: p[3] as number,
      transports: csv ? csv.split(",") : null, name: p[5] as string,
      created_at: new Date(now()), last_used_at: null
    };
    t.passkeys.push(row);
    return { rows: [{ id: row.id }] };
  }
  if (text.startsWith("SELECT id::text AS id FROM user_passkeys WHERE user_id = $1::uuid FOR UPDATE")) {
    return { rows: t.passkeys.filter((r) => r.user_id === p[0]).map((r) => ({ id: r.id })) };
  }
  if (text.startsWith("DELETE FROM user_passkeys")) {
    const before = t.passkeys.length;
    t.passkeys = t.passkeys.filter((r) => !(r.id === p[0] && r.user_id === p[1]));
    return { rows: before === t.passkeys.length ? [] : [{ id: p[0] }] };
  }
  if (text.startsWith("DELETE FROM user_recovery_codes")) {
    t.codes = t.codes.filter((r) => r.user_id !== p[0]);
    return { rows: [] };
  }
  if (text.startsWith("INSERT INTO user_recovery_codes")) {
    if (t.codes.some((r) => r.code_hash === p[1])) throw new Error("duplicate code_hash");
    t.codes.push({ id: newId(), user_id: p[0] as string, code_hash: p[1] as string, used_at: null });
    return { rows: [] };
  }
  if (text.startsWith("UPDATE user_recovery_codes SET used_at = now()")) {
    const row = t.codes.find((r) => r.user_id === p[0] && r.code_hash === p[1] && r.used_at === null);
    if (!row) return { rows: [] };
    row.used_at = now();
    return { rows: [{ id: row.id }] };
  }
  if (text === "DELETE FROM mfa_challenges WHERE user_id = $1::uuid AND consumed_at IS NULL") {
    t.challenges = t.challenges.filter((r) => !(r.user_id === p[0] && r.consumed_at === null));
    return { rows: [] };
  }
  if (text === "SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE") {
    return { rows: [{ "?column?": 1 }] };
  }
  if (text === "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE") {
    return {
      rows: p[0] === fake.user.id
        ? [{ password_hash: fake.user.passwordHash, is_active: fake.user.isActive, locked_until: fake.user.lockedUntil }]
        : []
    };
  }
  if (text === "SELECT sign_count FROM user_passkeys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE") {
    const row = t.passkeys.find((r) => r.id === p[0] && r.user_id === p[1]);
    return { rows: row ? [{ sign_count: row.sign_count }] : [] };
  }
  if (text.startsWith("SELECT count(*)::int AS unused FROM user_recovery_codes")) {
    return { rows: [{ unused: t.codes.filter((r) => r.user_id === p[0] && r.used_at === null).length }] };
  }
  throw new Error(`unexpected SQL in test: ${text}`);
}

function cloneTables(t: Tables): Tables {
  return {
    challenges: t.challenges.map((r) => ({ ...r })),
    passkeys: t.passkeys.map((r) => ({ ...r })),
    codes: t.codes.map((r) => ({ ...r }))
  };
}

vi.mock("../../lib/db-client.js", () => {
  const execute = async (query: SQL) => runSql(query);
  return {
    db: {
      execute,
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...fake.user }] }) }) }),
      insert: () => ({ values: async (values: unknown) => { fake.sessionInsert(values); } }),
      update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
      // Snapshot and restore, so a rolled-back transaction leaves no writes.
      // SELECT ... FOR UPDATE waits for and then holds a per-user lock until
      // the transaction ends, as Postgres row locks do. A transaction that
      // already holds the key does not wait on itself, as Postgres does not
      // for a row lock it holds (the MFA management routes lock the user row
      // and then the passkey or user row again under the same key).
      transaction: async <T>(work: (tx: { execute: typeof execute; isTx: true }) => Promise<T>): Promise<T> => {
        const before = fake.beforeNextTransaction;
        fake.beforeNextTransaction = null;
        before?.();
        const snapshot = cloneTables(fake.tables);
        const releases: Array<() => void> = [];
        const held = new Set<string>();
        const txId = ++fake.txCounter;
        const txExecute = async (query: SQL) => {
          const { sql: raw, params } = dialect.sqlToQuery(query);
          fake.txLog.push({ tx: txId, op: raw.replace(/\s+/g, " ").trim() });
          if (/\bFOR UPDATE\b/.test(raw) && !held.has(String(params[0]))) {
            const key = String(params[0]);
            held.add(key);
            while (fake.rowLocks.has(key)) await fake.rowLocks.get(key);
            let release!: () => void;
            fake.rowLocks.set(key, new Promise<void>((resolve) => { release = resolve; }));
            releases.push(() => {
              fake.rowLocks.delete(key);
              release();
            });
          }
          return runSql(query);
        };
        // The Drizzle builder calls of POST /api/auth/reset-password; the
        // password write and session revoke are recorded in order.
        const builder = {
          update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: () => {
            if (table === passwordResetTokens) {
              return { returning: async () => [{ userId: SUPER.id }] };
            }
            fake.txWrites.push("update-password");
            Object.assign(fake.user, values);
            return Promise.resolve();
          } }) }),
          select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...fake.user }] }) }) }),
          delete: () => ({ where: async () => { fake.txWrites.push("revoke-sessions"); } }),
          insert: () => ({ values: async (values: unknown) => {
            if (fake.sessionInsertFailure) throw fake.sessionInsertFailure;
            fake.txLog.push({ tx: txId, op: "insert-session" });
            fake.sessionInsert(values);
          } })
        };
        try {
          return await work({ execute: txExecute, isTx: true, ...builder } as unknown as { execute: typeof execute; isTx: true });
        } catch (err) {
          fake.tables = snapshot;
          throw err;
        } finally {
          for (const release of releases) release();
        }
      }
    }
  };
});
vi.mock("../../lib/auth/passwords.js", () => ({
  verifyPassword: fake.verifyPassword,
  hashPassword: async () => "dummy-password-hash"
}));
vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEventBestEffort: fake.audit,
  appendSecurityEvent: async (input: unknown, executor?: { isTx?: boolean }) => {
    fake.audit(input);
    fake.auditInTx.push(executor?.isTx === true);
    if (fake.appendFailure) throw fake.appendFailure;
    return {};
  }
}));
vi.mock("../../lib/observability/error-log.js", () => ({ recordAppError: async () => true }));
vi.mock("../../lib/auth/rate-limit.js", () => ({
  clientIpFrom: () => "203.0.113.9",
  loginIpLimiter: { hit: () => true },
  forgotPasswordEmailLimiter: { hit: () => true },
  forgotPasswordIpLimiter: { hit: () => true }
}));
vi.mock("../../lib/auth/lockout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth/lockout.js")>()),
  recordAuthFailure: fake.recordAuthFailure,
  recordAuthSuccess: fake.recordAuthSuccess
}));
// The reset link's preflight lookup; the in-transaction consume is the
// builder fake above.
vi.mock("../../lib/auth/password-reset.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth/password-reset.js")>()),
  lookupResetTokenUserId: async () => "00000000-0000-4000-8000-0000000000a1"
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyAuthenticationResponse: fake.verifyAuthentication,
  verifyRegistrationResponse: fake.verifyRegistration
}));

import { authRouter } from "../auth.js";
import { mfaRouter } from "../mfa.js";
import { SESSION_COOKIE_NAME } from "../../lib/auth/sessions.js";
import { findLoginChallenge } from "../../lib/auth/mfa.js";
import { mfaLoginIpLimit, mfaManageLimit } from "../../lib/security/route-rate-limit.js";
import type { CurrentUser } from "../../lib/auth/current-user.js";

const SUPER: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000a1",
  email: "emergency@example.com",
  role: "super_user",
  programId: null,
  name: "Emergency Admin",
  mustResetPassword: false
};
const MANAGER: CurrentUser = { ...SUPER, id: "00000000-0000-4000-8000-0000000000a2", role: "manager", email: "manager@example.com" };
// A super_user still on a temporary password (must_reset_password).
const STALE: CurrentUser = { ...SUPER, id: "00000000-0000-4000-8000-0000000000a3", mustResetPassword: true };
const PASSWORD = "correct-password";
const CREDENTIAL_ID = "c3ludGhldGljLWNyZWRlbnRpYWw";
// listPasskeys (lib/auth/mfa.ts) as the fake records it.
const PASSKEY_LIST = "SELECT id::text AS id, user_id::text AS user_id, credential_id, public_key, sign_count, " +
  "transports, name, created_at, last_used_at FROM user_passkeys WHERE user_id = $1::uuid ORDER BY created_at";

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // Stand-in for attachCurrentUser: the session lookup is not under test.
  app.use((req, _res, next) => {
    const id = req.header("x-test-user");
    req.user = id === SUPER.id ? SUPER : id === MANAGER.id ? MANAGER : id === STALE.id ? STALE : null;
    next();
  });
  app.use("/api/auth", authRouter);
  app.use("/api/auth/mfa", mfaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
  vi.stubEnv("WEBAUTHN_RP_ID", undefined);
  vi.stubEnv("WEBAUTHN_ORIGINS", undefined);
  vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
  for (const name of ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET", "DEMO_LOGIN_ACCOUNTS"]) {
    vi.stubEnv(name, undefined);
  }
  fake.user = {
    ...SUPER,
    passwordHash: "stored-password-hash",
    isActive: true,
    lockedUntil: null,
    failedLoginCount: 0
  };
  fake.tables = { challenges: [], passkeys: [], codes: [] };
  fake.clockOffset = 0;
  fake.sql = [];
  fake.rowLocks.clear();
  fake.auditInTx = [];
  fake.appendFailure = null;
  fake.txWrites = [];
  fake.txLog = [];
  fake.sessionInsertFailure = null;
  fake.beforeNextTransaction = null;
  // The route limiters keep in-memory counts for the whole file.
  mfaManageLimit.resetKey(SUPER.id);
  mfaLoginIpLimit.resetKey("203.0.113.9");
  fake.verifyPassword.mockImplementation(async (password: string, hash: string) =>
    hash === "stored-password-hash" && password === PASSWORD);
  fake.recordAuthFailure.mockResolvedValue({ locked: false, lockedNow: false, lockedUntil: null });
  fake.recordAuthSuccess.mockResolvedValue(undefined);
  fake.verifyAuthentication.mockResolvedValue({
    verified: true,
    authenticationInfo: { credentialID: CREDENTIAL_ID, newCounter: 7, userVerified: true }
  });
});
afterEach(() => vi.unstubAllEnvs());

function enrollPasskey() {
  fake.tables.passkeys.push({
    id: newId(), user_id: SUPER.id, credential_id: CREDENTIAL_ID,
    public_key: new Uint8Array([9, 8, 7]), sign_count: 3, transports: ["internal"],
    name: "Laptop", created_at: new Date(), last_used_at: null
  });
}

interface Reply {
  status: number;
  body: Record<string, unknown> | null;
  cookies: string[];
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cookies: res.headers.getSetCookie() };
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const entry = cookies.find((c) => c.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1).split(";")[0]!) : undefined;
}

async function passwordStep() {
  const reply = await call("POST", "/api/auth/login", { email: SUPER.email, password: PASSWORD });
  const token = cookieValue(reply.cookies, "truenote_mfa");
  return { reply, cookie: token ? `truenote_mfa=${token}` : "", token };
}

const assertion = {
  id: CREDENTIAL_ID,
  rawId: CREDENTIAL_ID,
  type: "public-key",
  response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "AAAA" },
  clientExtensionResults: {}
};

function asSuper(extra: Record<string, string> = {}) {
  return { "x-test-user": SUPER.id, ...extra };
}

describe("login with an enrolled passkey", () => {
  it("accepts the password but issues no session, only an MFA challenge", async () => {
    enrollPasskey();
    const { reply, token } = await passwordStep();
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      mfaRequired: true,
      methods: ["passkey", "recovery_code"],
      passkeyOptions: {
        rpId: "app.example.com",
        allowCredentials: [{ id: CREDENTIAL_ID, type: "public-key", transports: ["internal"] }],
        userVerification: "required"
      }
    });
    expect(reply.body).not.toHaveProperty("user");
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();

    const mfaCookie = reply.cookies.find((c) => c.startsWith("truenote_mfa="))!;
    expect(mfaCookie).toMatch(/HttpOnly/i);
    expect(mfaCookie).toMatch(/SameSite=Lax/i);
    expect(mfaCookie).toMatch(/Path=\/api\/auth\/mfa/);
    expect(mfaCookie).toMatch(/Secure/i);

    // Only the token's hash is stored, with the options' challenge.
    expect(fake.tables.challenges).toHaveLength(1);
    const row = fake.tables.challenges[0]!;
    expect(row.token_hash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(JSON.stringify(fake.tables)).not.toContain(token!);
    expect(row.challenge).toBe((reply.body!.passkeyOptions as { challenge: string }).challenge);
    expect(row.expires_at - now()).toBeGreaterThan(4 * 60_000);
    expect(row.expires_at - now()).toBeLessThanOrEqual(5 * 60_000);
  });

  it("issues the session after a correct passkey assertion", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({
      user: {
        id: SUPER.id, email: SUPER.email, role: "super_user", programId: null,
        name: SUPER.name, mustResetPassword: false
      }
    });
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeTruthy();
    // The MFA cookie is cleared.
    expect(reply.cookies.find((c) => c.startsWith("truenote_mfa="))).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
    // The reset runs on the completion transaction's executor.
    expect(fake.recordAuthSuccess).toHaveBeenCalledWith(SUPER.id, expect.objectContaining({ isTx: true }));
    expect(fake.recordAuthFailure).not.toHaveBeenCalled();

    const verifyArgs = fake.verifyAuthentication.mock.calls[0]![0];
    expect(verifyArgs).toMatchObject({
      expectedChallenge: fake.tables.challenges[0]!.challenge,
      expectedOrigin: ["https://app.example.com"],
      expectedRPID: "app.example.com",
      requireUserVerification: true,
      credential: { id: CREDENTIAL_ID, counter: 3 }
    });
    expect(Array.from(verifyArgs.credential.publicKey as Uint8Array)).toEqual([9, 8, 7]);
    expect(fake.tables.passkeys[0]!.sign_count).toBe(7);
    expect(fake.tables.passkeys[0]!.last_used_at).toBeInstanceOf(Date);
    expect(fake.tables.challenges[0]!.consumed_at).not.toBeNull();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.break_glass.login",
      outcome: "success",
      details: { authMethod: "local", mfa: "passkey" }
    }));
  });

  it("refuses a failed assertion, counts it toward lockout, and keeps the challenge", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.verifyAuthentication.mockResolvedValueOnce({ verified: false, authenticationInfo: { newCounter: 0 } });
    const rejected = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ error: "Invalid credentials" });
    expect(cookieValue(rejected.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.recordAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER.id, email: SUPER.email }),
      { factor: "passkey", sourceIp: "203.0.113.9" }
    );
    expect(fake.tables.passkeys[0]!.sign_count).toBe(3);

    // A thrown verification error is the same failure.
    fake.verifyAuthentication.mockRejectedValueOnce(new Error("Unexpected authentication response origin"));
    expect((await call("POST", "/api/auth/mfa/passkey", assertion, { cookie })).status).toBe(401);
    expect(fake.recordAuthFailure).toHaveBeenCalledTimes(2);

    // An unknown credential is refused without reaching verification.
    fake.verifyAuthentication.mockClear();
    const unknown = await call("POST", "/api/auth/mfa/passkey", { ...assertion, id: "b3RoZXI", rawId: "b3RoZXI" }, { cookie });
    expect(unknown.status).toBe(401);
    expect(fake.verifyAuthentication).not.toHaveBeenCalled();
    expect(fake.recordAuthFailure).toHaveBeenCalledTimes(3);

    // The unconsumed challenge still completes.
    expect((await call("POST", "/api/auth/mfa/passkey", assertion, { cookie })).status).toBe(200);
  });

  it("refuses an expired challenge without verifying", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.clockOffset = 5 * 60_000 + 1000;
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply.status).toBe(401);
    expect(reply.body).toMatchObject({ code: "mfa_expired" });
    expect(fake.verifyAuthentication).not.toHaveBeenCalled();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });

  it("refuses a consumed challenge", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    expect((await call("POST", "/api/auth/mfa/passkey", assertion, { cookie })).status).toBe(200);
    const replay = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: "mfa_expired" });
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
  });

  it("refuses the MFA step without a challenge cookie", async () => {
    enrollPasskey();
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion);
    expect(reply.status).toBe(401);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });

  it("refuses the MFA step once the account is locked or local login is no longer allowed", async () => {
    enrollPasskey();
    const first = await passwordStep();
    fake.user.lockedUntil = new Date(Date.now() + 60_000);
    const locked = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie: first.cookie });
    expect(locked).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(fake.verifyAuthentication).not.toHaveBeenCalled();

    fake.user.lockedUntil = null;
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    const disabled = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie: first.cookie });
    expect(disabled).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });

  it("also requires the passkey in enabled mode", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    enrollPasskey();
    const { reply, cookie } = await passwordStep();
    expect(reply.body).toMatchObject({ mfaRequired: true });
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect((await call("POST", "/api/auth/mfa/passkey", assertion, { cookie })).status).toBe(200);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.local.login", outcome: "success" }));
  });

  // Rule: an unusable WebAuthn configuration must not lock the emergency
  // account out. The second factor still applies, through recovery codes only.
  it("offers only recovery codes when WebAuthn is not configured in production", async () => {
    vi.stubEnv("APP_BASE_URL", "");
    const generated = await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    const codes = generated.body!.codes as string[];
    enrollPasskey();

    const { reply, cookie } = await passwordStep();
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ mfaRequired: true, methods: ["recovery_code"] });
    expect(reply.body).not.toHaveProperty("passkeyOptions");
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(cookie).not.toBe("");
    expect(fake.tables.challenges).toHaveLength(1);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.mfa.webauthn_unconfigured",
      outcome: "failure",
      actor: { id: SUPER.id, email: SUPER.email, role: "super_user" },
      details: expect.objectContaining({ reason: "webauthn_unconfigured", methods: ["recovery_code"] })
    }));

    // The passkey endpoint stays refused and leaves the challenge usable.
    const passkey = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(passkey).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(fake.verifyAuthentication).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.mfa.verify",
      outcome: "denied",
      details: { authMethod: "local", factor: "passkey", reason: "webauthn_unconfigured" }
    }));

    // A recovery code completes the sign-in.
    const ok = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie });
    expect(ok.status).toBe(200);
    expect(cookieValue(ok.cookies, SESSION_COOKIE_NAME)).toBeTruthy();
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
    expect(fake.tables.challenges[0]!.consumed_at).not.toBeNull();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.break_glass.login",
      outcome: "success",
      details: { authMethod: "local", mfa: "recovery_code" }
    }));
  });
});

describe("break_glass without a passkey", () => {
  it("refuses the super_user with the generic 401 and an mfa_missing event", async () => {
    const { reply } = await passwordStep();
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Invalid credentials" });
    expect(reply.cookies).toEqual([]);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.break_glass.mfa_missing",
      outcome: "denied",
      actor: { id: SUPER.id, email: SUPER.email, role: "super_user" }
    }));
  });

  it("keeps password-only login for an enabled-mode user without a passkey", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    const { reply } = await passwordStep();
    expect(reply.status).toBe(200);
    expect(reply.body).toHaveProperty("user");
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
  });
});

describe("recovery codes", () => {
  async function generateCodes(): Promise<string[]> {
    const reply = await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    expect(reply.status).toBe(200);
    return reply.body!.codes as string[];
  }

  it("generates 10 codes of at least 80 bits and stores only their hashes", async () => {
    const codes = await generateCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      // 16 base32 characters = 80 bits.
      expect(code).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    }
    const stored = JSON.stringify(fake.tables.codes);
    for (const code of codes) {
      expect(stored).not.toContain(code);
      expect(stored).not.toContain(code.replace(/-/g, ""));
    }
    expect(fake.tables.codes.map((r) => r.code_hash).sort()).toEqual(
      codes.map((c) => createHash("sha256").update(c.replace(/-/g, "")).digest("hex")).sort()
    );
    expect(JSON.stringify(fake.audit.mock.calls)).not.toContain(codes[0]!);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.mfa.recovery_codes.generated", outcome: "success"
    }));

    const status = await call("GET", "/api/auth/mfa/status", undefined, asSuper());
    expect(status.body).toMatchObject({ unusedRecoveryCodes: 10 });

    // A new set replaces the old one.
    const second = await generateCodes();
    expect(fake.tables.codes).toHaveLength(10);
    expect(second).not.toContain(codes[0]);
  });

  it("signs in with a code once; the second use fails and counts toward lockout", async () => {
    const codes = await generateCodes();
    enrollPasskey();

    const first = await passwordStep();
    const ok = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie: first.cookie });
    expect(ok.status).toBe(200);
    expect(cookieValue(ok.cookies, SESSION_COOKIE_NAME)).toBeTruthy();
    expect(fake.recordAuthSuccess).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.break_glass.login", details: { authMethod: "local", mfa: "recovery_code" }
    }));

    const second = await passwordStep();
    const reused = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie: second.cookie });
    expect(reused.status).toBe(401);
    expect(reused.body).toEqual({ error: "Invalid credentials" });
    expect(fake.recordAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER.id }),
      { factor: "recovery_code", sourceIp: "203.0.113.9" }
    );
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);

    // Another code, typed in capitals without hyphens, still works on the
    // same (unconsumed) challenge.
    const typed = codes[1]!.replace(/-/g, "").toUpperCase();
    const next = await call("POST", "/api/auth/mfa/recovery-code", { code: typed }, { cookie: second.cookie });
    expect(next.status).toBe(200);
    expect(fake.tables.codes.filter((r) => r.used_at !== null)).toHaveLength(2);
  });

  it("keeps the code unspent when the challenge expired", async () => {
    const codes = await generateCodes();
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.clockOffset = 6 * 60_000;
    const reply = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie });
    expect(reply.status).toBe(401);
    expect(fake.tables.codes.every((r) => r.used_at === null)).toBe(true);
  });

  it("appends the generation event in the replacement transaction; a failed append keeps the old codes", async () => {
    const codes = await generateCodes();
    expect(fake.auditInTx).toEqual([true]);
    const hashes = fake.tables.codes.map((r) => r.code_hash).sort();
    expect(hashes).toEqual(
      codes.map((c) => createHash("sha256").update(c.replace(/-/g, "")).digest("hex")).sort()
    );

    fake.appendFailure = new Error("audit append failed");
    const res = await fetch(`${base}/api/auth/mfa/recovery-codes`, {
      method: "POST",
      headers: { "content-type": "application/json", ...asSuper() },
      body: JSON.stringify({ password: PASSWORD })
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}/);
    expect(fake.auditInTx).toEqual([true, true]);
    expect(fake.tables.codes.map((r) => r.code_hash).sort()).toEqual(hashes);
  });
});

describe("enrollment", () => {
  const registration = {
    id: "bmV3LWNyZWRlbnRpYWw",
    rawId: "bmV3LWNyZWRlbnRpYWw",
    type: "public-key",
    response: { clientDataJSON: "e30", attestationObject: "o2NmbXRkbm9uZQ", transports: ["internal"] },
    clientExtensionResults: {}
  };

  it.each([
    ["GET", "/api/auth/mfa/status"],
    ["POST", "/api/auth/mfa/passkeys/options"],
    ["POST", "/api/auth/mfa/passkeys"],
    ["DELETE", "/api/auth/mfa/passkeys/00000000-0000-4000-8000-000000000001"],
    ["POST", "/api/auth/mfa/recovery-codes"]
  ])("%s %s refuses a signed-out caller and a non-super_user", async (method, path) => {
    const body = method === "GET" ? undefined : { password: PASSWORD, response: registration };
    expect((await call(method, path, body)).status).toBe(401);
    expect((await call(method, path, body, { "x-test-user": MANAGER.id })).status).toBe(403);
    expect(fake.verifyPassword).not.toHaveBeenCalled();
    expect(fake.tables.codes).toHaveLength(0);
    expect(fake.tables.challenges).toHaveLength(0);
  });

  it.each([
    ["POST", "/api/auth/mfa/passkeys/options"],
    ["POST", "/api/auth/mfa/passkeys"],
    ["DELETE", "/api/auth/mfa/passkeys/PASSKEY"],
    ["POST", "/api/auth/mfa/recovery-codes"]
  ])("%s %s refuses a wrong password and counts it toward lockout", async (method, rawPath) => {
    enrollPasskey();
    const path = rawPath.replace("PASSKEY", fake.tables.passkeys[0]!.id);
    const reply = await call(method, path, { password: "wrong-password", response: registration }, asSuper());
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Current password is incorrect" });
    expect(fake.recordAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER.id }),
      { factor: "password", sourceIp: "203.0.113.9" }
    );
    expect(fake.tables.codes).toHaveLength(0);
    expect(fake.tables.passkeys).toHaveLength(1);
    expect(fake.tables.challenges).toHaveLength(0);
    expect(fake.verifyRegistration).not.toHaveBeenCalled();
  });

  it("adds a passkey, lists it without key material, and removes it", async () => {
    const options = await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper());
    expect(options.status).toBe(200);
    expect(options.body!.options).toMatchObject({
      rp: { id: "app.example.com", name: "Truenote" },
      user: { name: SUPER.email, displayName: SUPER.name },
      authenticatorSelection: { userVerification: "required" }
    });
    const challenge = (options.body!.options as { challenge: string }).challenge;
    expect(fake.tables.challenges[0]).toMatchObject({ purpose: "register", challenge, token_hash: null });

    fake.verifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: registration.id, publicKey: new Uint8Array([4, 5, 6]), counter: 0, transports: ["internal", "hybrid"] }
      }
    });
    const added = await call("POST", "/api/auth/mfa/passkeys",
      { password: PASSWORD, name: "Office key", response: registration }, asSuper());
    expect(added.status).toBe(201);
    expect(fake.verifyRegistration.mock.calls[0]![0]).toMatchObject({
      expectedChallenge: challenge,
      expectedOrigin: ["https://app.example.com"],
      expectedRPID: "app.example.com",
      requireUserVerification: true
    });
    expect(fake.tables.passkeys).toHaveLength(1);
    expect(fake.tables.passkeys[0]).toMatchObject({
      user_id: SUPER.id, credential_id: registration.id, name: "Office key", transports: ["internal", "hybrid"]
    });
    expect(Array.from(fake.tables.passkeys[0]!.public_key)).toEqual([4, 5, 6]);
    expect(fake.tables.challenges[0]!.consumed_at).not.toBeNull();
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.passkey.added" }));

    const status = await call("GET", "/api/auth/mfa/status", undefined, asSuper());
    expect(status.status).toBe(200);
    const listed = (status.body!.passkeys as Array<Record<string, unknown>>);
    expect(listed).toHaveLength(1);
    expect(Object.keys(listed[0]!).sort()).toEqual(["createdAt", "id", "lastUsedAt", "name"]);
    expect(status.body).toMatchObject({ passkeyAvailable: true, unusedRecoveryCodes: 0 });

    // The register challenge is single use.
    const replay = await call("POST", "/api/auth/mfa/passkeys",
      { password: PASSWORD, response: registration }, asSuper());
    expect(replay.status).toBe(409);

    // break_glass keeps the last passkey; enabled mode lets it go.
    const id = listed[0]!.id as string;
    expect((await call("DELETE", `/api/auth/mfa/passkeys/${id}`, { password: PASSWORD }, asSuper())).status).toBe(409);
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    expect((await call("DELETE", `/api/auth/mfa/passkeys/${id}`, { password: PASSWORD }, asSuper())).status).toBe(204);
    expect(fake.tables.passkeys).toHaveLength(0);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.passkey.removed", resourceId: id }));
  });

  // Rule: in break_glass mode two concurrent deletes of the last two
  // passkeys leave one. The check and the delete share a transaction that
  // locks the user's passkey rows first.
  it("keeps one passkey when two deletes race in break_glass mode", async () => {
    enrollPasskey();
    fake.tables.passkeys.push({
      id: newId(), user_id: SUPER.id, credential_id: "c2Vjb25kLWNyZWRlbnRpYWw",
      public_key: new Uint8Array([1, 2, 3]), sign_count: 0, transports: null,
      name: "Backup key", created_at: new Date(), last_used_at: null
    });
    const [first, second] = fake.tables.passkeys.map((p) => p.id);

    // Hold both requests at the password check, then release them together.
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let arrived = 0;
    fake.verifyPassword.mockImplementation(async (password: string, hash: string) => {
      arrived += 1;
      await gate;
      return hash === "stored-password-hash" && password === PASSWORD;
    });
    const a = call("DELETE", `/api/auth/mfa/passkeys/${first}`, { password: PASSWORD }, asSuper());
    const b = call("DELETE", `/api/auth/mfa/passkeys/${second}`, { password: PASSWORD }, asSuper());
    await vi.waitFor(() => expect(arrived).toBe(2));
    open();
    const statuses = (await Promise.all([a, b])).map((r) => r.status).sort();
    expect(statuses).toEqual([204, 409]);
    expect(fake.tables.passkeys).toHaveLength(1);

    // The lock is taken before the delete.
    const lockAt = fake.sql.findIndex((s) => s.includes("FROM user_passkeys WHERE user_id = $1::uuid FOR UPDATE"));
    const deleteAt = fake.sql.findIndex((s) => s.startsWith("DELETE FROM user_passkeys"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(lockAt);
  });

  it("refuses a registration that does not verify", async () => {
    await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper());
    fake.verifyRegistration.mockRejectedValueOnce(new Error("Unexpected registration response origin"));
    const reply = await call("POST", "/api/auth/mfa/passkeys", { password: PASSWORD, response: registration }, asSuper());
    expect(reply.status).toBe(400);
    expect(fake.tables.passkeys).toHaveLength(0);
  });

  it("reports enrollment unavailable when WebAuthn is not configured in production", async () => {
    vi.stubEnv("APP_BASE_URL", "");
    const reply = await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper());
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ code: "webauthn_unconfigured" });
    const status = await call("GET", "/api/auth/mfa/status", undefined, asSuper());
    expect(status.body).toMatchObject({ passkeyAvailable: false });
  });
});

// Finding: a challenge created with the old password used to stay usable
// for its 5 minutes after a password reset revoked every session.
describe("a password reset ends pending MFA", () => {
  const RESET_TOKEN = "synthetic_reset_token_at_least_16_chars";
  const NEW_PASSWORD = "synthetic-new-password-long-enough-for-policy";

  it("refuses the old login challenge afterwards and deletes every unconsumed challenge in the reset transaction", async () => {
    const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
    enrollPasskey();

    // One completed login (its consumed row stays), one pending login and
    // one pending passkey registration.
    const done = await passwordStep();
    expect((await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie: done.cookie })).status).toBe(200);
    const pending = await passwordStep();
    expect(await findLoginChallenge(pending.token)).not.toBeNull();
    expect((await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper())).status).toBe(200);
    expect(fake.tables.challenges.map((r) => [r.purpose, r.consumed_at === null])).toEqual([
      ["login", false], ["login", true], ["register", true]
    ]);
    const sessionsBefore = fake.sessionInsert.mock.calls.length;

    fake.sql = [];
    const reset = await call("POST", "/api/auth/reset-password", { token: RESET_TOKEN, newPassword: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ passwordReset: true, signInRequired: true });
    expect(fake.user.passwordHash).toBe("dummy-password-hash");
    expect(fake.txWrites).toEqual(["update-password", "revoke-sessions"]);
    expect(fake.sql).toContain("DELETE FROM mfa_challenges WHERE user_id = $1::uuid AND consumed_at IS NULL");
    expect(fake.tables.challenges).toHaveLength(1);
    expect(fake.tables.challenges[0]!.consumed_at).not.toBeNull();

    // The old challenge no longer resolves, and the recovery-code step
    // refuses it without spending the code or issuing a session.
    expect(await findLoginChallenge(pending.token)).toBeNull();
    const late = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[1] }, { cookie: pending.cookie });
    expect(late.status).toBe(401);
    expect(late.body).toMatchObject({ code: "mfa_expired" });
    expect(cookieValue(late.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.tables.codes.filter((r) => r.used_at !== null)).toHaveLength(1);
    expect(fake.sessionInsert).toHaveBeenCalledTimes(sessionsBefore);
  });
});

// Finding: MFA management used to work while the account still had a
// temporary password. The login-step routes need no session and stay open.
describe("MFA management with a temporary password", () => {
  it.each([
    ["GET", "/api/auth/mfa/status"],
    ["POST", "/api/auth/mfa/passkeys/options"],
    ["POST", "/api/auth/mfa/passkeys"],
    ["DELETE", "/api/auth/mfa/passkeys/00000000-0000-4000-8000-000000000001"],
    ["POST", "/api/auth/mfa/recovery-codes"]
  ])("%s %s answers 423 until the password is changed", async (method, path) => {
    const body = method === "GET" ? undefined : { password: PASSWORD, name: "Key", response: { id: "x", rawId: "x", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "o2NmbXRkbm9uZQ" }, clientExtensionResults: {} } };
    const reply = await call(method, path, body, { "x-test-user": STALE.id });
    expect(reply.status).toBe(423);
    expect(reply.body).toEqual({ error: "Password reset required" });
    expect(fake.verifyPassword).not.toHaveBeenCalled();
    expect(fake.verifyRegistration).not.toHaveBeenCalled();
    expect(fake.sql).toEqual([]);
    expect(fake.tables).toEqual({ challenges: [], passkeys: [], codes: [] });
  });

  it("leaves the login-step routes reachable", async () => {
    const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
    enrollPasskey();

    const first = await passwordStep();
    const passkey = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie: first.cookie, "x-test-user": STALE.id });
    expect(passkey.status).toBe(200);

    const second = await passwordStep();
    const recovery = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie: second.cookie });
    expect(recovery.status).toBe(200);
    expect(fake.sessionInsert).toHaveBeenCalledTimes(2);
  });
});

// Finding: two overlapping generations could both delete before either
// inserted, leaving 20 valid codes. The user's row is locked first.
describe("concurrent recovery-code generation", () => {
  it("leaves exactly one set of 10 codes", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let arrived = 0;
    fake.verifyPassword.mockImplementation(async (password: string, hash: string) => {
      arrived += 1;
      await gate;
      return hash === "stored-password-hash" && password === PASSWORD;
    });
    const a = call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    const b = call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    await vi.waitFor(() => expect(arrived).toBe(2));
    open();
    const replies = await Promise.all([a, b]);
    expect(replies.map((r) => r.status)).toEqual([200, 200]);

    expect(fake.tables.codes).toHaveLength(10);
    const stored = fake.tables.codes.map((r) => r.code_hash).sort();
    const hashesOf = (codes: string[]) =>
      codes.map((c) => createHash("sha256").update(c.replace(/-/g, "")).digest("hex")).sort();
    const sets = replies.map((r) => hashesOf(r.body!.codes as string[]));
    expect(sets.filter((set) => JSON.stringify(set) === JSON.stringify(stored))).toHaveLength(1);

    // Each generation locks the user's row before its DELETE.
    const kinds = fake.sql
      .filter((s) => s === "SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE" || s.startsWith("DELETE FROM user_recovery_codes"))
      .map((s) => (s.startsWith("SELECT") ? "lock" : "delete"));
    expect(kinds).toEqual(["lock", "delete", "lock", "delete"]);
  });
});

// Finding: the challenge was consumed and committed, then the session was
// created separately, so a password write committing in between revoked the
// old sessions and missed the new one. The user row lock, the challenge
// consume, the factor's write and the session insert now share one
// transaction, and the cookie is set only after it commits.
describe("MFA completion in one transaction", () => {
  const USER_LOCK = "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE";
  const CONSUME = "UPDATE mfa_challenges SET consumed_at = now()";

  function sessionTxOps(): string[] {
    const insert = fake.txLog.find((e) => e.op === "insert-session");
    expect(insert).toBeDefined();
    return fake.txLog.filter((e) => e.tx === insert!.tx).map((e) => e.op);
  }

  async function failingCall(path: string, body: unknown, cookie: string) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body)
    });
    await res.text();
    return { status: res.status, cookies: res.headers.getSetCookie() };
  }

  it("passkey: locks the user, consumes the challenge, writes the counter and inserts the session in one transaction", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.txLog = [];
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply.status).toBe(200);
    const ops = sessionTxOps();
    expect(ops).toHaveLength(5);
    expect(ops[0]).toBe(USER_LOCK);
    expect(ops[1]).toMatch(/^UPDATE mfa_challenges SET consumed_at = now\(\)/);
    expect(ops[2]).toBe("SELECT sign_count FROM user_passkeys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE");
    expect(ops[3]).toMatch(/^UPDATE user_passkeys SET sign_count/);
    expect(ops[4]).toBe("insert-session");
    // No other transaction ran for this step.
    expect(new Set(fake.txLog.map((e) => e.tx)).size).toBe(1);
  });

  it("recovery code: locks the user, consumes the challenge, spends the code and inserts the session in one transaction", async () => {
    const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.txLog = [];
    const reply = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie });
    expect(reply.status).toBe(200);
    const ops = sessionTxOps();
    expect(ops).toHaveLength(4);
    expect(ops[0]).toBe(USER_LOCK);
    expect(ops[1]!.startsWith(CONSUME)).toBe(true);
    expect(ops[2]).toMatch(/^UPDATE user_recovery_codes SET used_at = now\(\)/);
    expect(ops[3]).toBe("insert-session");
    expect(new Set(fake.txLog.map((e) => e.tx)).size).toBe(1);
  });

  it("passkey: a failed session insert rolls back the consume and the counter and sets no cookie", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.sessionInsertFailure = new Error("session insert failed");
    const failed = await failingCall("/api/auth/mfa/passkey", assertion, cookie);
    expect(failed.status).toBe(500);
    expect(cookieValue(failed.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(failed.cookies.find((c) => c.startsWith("truenote_mfa="))).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.tables.passkeys[0]!.sign_count).toBe(3);
    expect(fake.tables.passkeys[0]!.last_used_at).toBeNull();
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));

    // The challenge is still usable once the insert works.
    fake.sessionInsertFailure = null;
    const retry = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(retry.status).toBe(200);
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
  });

  it("recovery code: a failed session insert rolls back the consume and the code and sets no cookie", async () => {
    const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.sessionInsertFailure = new Error("session insert failed");
    const failed = await failingCall("/api/auth/mfa/recovery-code", { code: codes[0] }, cookie);
    expect(failed.status).toBe(500);
    expect(cookieValue(failed.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(failed.cookies.find((c) => c.startsWith("truenote_mfa="))).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.tables.codes.every((r) => r.used_at === null)).toBe(true);

    fake.sessionInsertFailure = null;
    const retry = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie });
    expect(retry.status).toBe(200);
    expect(fake.tables.codes.filter((r) => r.used_at !== null)).toHaveLength(1);
  });

  it("a wrong recovery code rolls back the challenge consume", async () => {
    await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    enrollPasskey();
    const { cookie } = await passwordStep();
    const reply = await call("POST", "/api/auth/mfa/recovery-code", { code: "aaaa-aaaa-aaaa-aaaa" }, { cookie });
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });
});

// Finding: a password write could commit between the password check in
// /login and the challenge (or session) insert, leaving a challenge or
// session created from the old password.
describe("login rechecks the password hash under the user row lock", () => {
  function rotateDuringVerify() {
    fake.verifyPassword.mockImplementationOnce(async (password: string, hash: string) => {
      const ok = hash === "stored-password-hash" && password === PASSWORD;
      // A concurrent password write commits right after the check.
      fake.user.passwordHash = "rotated-password-hash";
      return ok;
    });
  }

  it("creates no challenge when the hash changed after the password check", async () => {
    enrollPasskey();
    rotateDuringVerify();
    const { reply } = await passwordStep();
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Invalid credentials" });
    expect(reply.cookies).toEqual([]);
    expect(fake.tables.challenges).toHaveLength(0);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.txLog.map((e) => e.op)).toEqual(["SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE"]);
  });

  it("creates the challenge in the locking transaction when the hash is unchanged", async () => {
    enrollPasskey();
    const { reply } = await passwordStep();
    expect(reply.status).toBe(200);
    const ops = fake.txLog.map((e) => e.op);
    expect(ops[0]).toBe("SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE");
    expect(ops[1]).toMatch(/^INSERT INTO mfa_challenges \(user_id, purpose, challenge, token_hash, expires_at\)/);
    expect(new Set(fake.txLog.map((e) => e.tx)).size).toBe(1);
  });

  it("issues no session on the password-only path when the hash changed", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    rotateDuringVerify();
    const { reply } = await passwordStep();
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Invalid credentials" });
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });

  it("inserts the password-only session in the locking transaction", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    const { reply } = await passwordStep();
    expect(reply.status).toBe(200);
    expect(fake.txLog.map((e) => e.op)).toEqual([
      "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE",
      PASSKEY_LIST,
      "insert-session"
    ]);
  });

  // Finding: the passkey list was read only before the lock, so a first
  // passkey committed after that read still let the password-only path
  // issue a session. The list is reread under the user row lock.
  it("issues no session on the password-only path when a passkey was enrolled after the first read", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    // The enrollment commits after the unlocked passkey read and before the
    // locking transaction.
    fake.beforeNextTransaction = enrollPasskey;
    const { reply } = await passwordStep();
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Invalid credentials" });
    expect(reply.cookies).toEqual([]);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.tables.challenges).toHaveLength(0);
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expect(fake.txLog.map((e) => e.op)).toEqual([
      "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE",
      PASSKEY_LIST
    ]);

    // The next attempt takes the MFA path.
    const next = await passwordStep();
    expect(next.reply.status).toBe(200);
    expect(next.reply.body).toMatchObject({ mfaRequired: true });
    expect(cookieValue(next.reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
  });
});

// Finding: MFA management verified the current password, then ran its
// write in a later transaction, so a password write committing in between
// (which revokes the session) did not stop it. Each write now locks the
// user row first and rechecks the hash the password was verified against.
describe("MFA management rechecks the password under the user row lock", () => {
  const USER_LOCK = "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE";
  const registration = {
    id: "bmV3LWNyZWRlbnRpYWw",
    rawId: "bmV3LWNyZWRlbnRpYWw",
    type: "public-key",
    response: { clientDataJSON: "e30", attestationObject: "o2NmbXRkbm9uZQ", transports: ["internal"] },
    clientExtensionResults: {}
  };

  // A password write commits right after requireCurrentPassword's check.
  function rotateDuringVerify() {
    fake.verifyPassword.mockImplementationOnce(async (password: string, hash: string) => {
      const ok = hash === "stored-password-hash" && password === PASSWORD;
      fake.user.passwordHash = "rotated-password-hash";
      return ok;
    });
  }

  function expectRefused(reply: Reply) {
    expect(reply.status).toBe(401);
    expect(reply.body).toEqual({ error: "Unauthorized" });
    expect(fake.recordAuthFailure).not.toHaveBeenCalled();
  }

  it("POST /passkeys adds no passkey when the hash changed after the check", async () => {
    expect((await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper())).status).toBe(200);
    fake.verifyRegistration.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: registration.id, publicKey: new Uint8Array([4, 5, 6]), counter: 0 } }
    });
    rotateDuringVerify();
    fake.txLog = [];
    const reply = await call("POST", "/api/auth/mfa/passkeys", { password: PASSWORD, response: registration }, asSuper());
    expectRefused(reply);
    expect(fake.tables.passkeys).toHaveLength(0);
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.passkey.added" }));
    expect(fake.txLog.map((e) => e.op)).toEqual([USER_LOCK]);
  });

  it("DELETE /passkeys/:id removes nothing when the hash changed after the check", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    enrollPasskey();
    const id = fake.tables.passkeys[0]!.id;
    rotateDuringVerify();
    const reply = await call("DELETE", `/api/auth/mfa/passkeys/${id}`, { password: PASSWORD }, asSuper());
    expectRefused(reply);
    expect(fake.tables.passkeys.map((p) => p.id)).toEqual([id]);
    expect(fake.sql.some((s) => s.startsWith("DELETE FROM user_passkeys"))).toBe(false);
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.passkey.removed" }));
  });

  it("POST /recovery-codes keeps the old codes and returns none when the hash changed after the check", async () => {
    const first = await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    expect(first.status).toBe(200);
    const before = fake.tables.codes.map((r) => ({ ...r }));
    expect(before).toHaveLength(10);
    vi.clearAllMocks();
    fake.auditInTx = [];
    rotateDuringVerify();
    const reply = await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    expectRefused(reply);
    expect(reply.body).not.toHaveProperty("codes");
    expect(fake.tables.codes).toEqual(before);
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.mfa.recovery_codes.generated" }));
    expect(fake.auditInTx).toEqual([]);
  });

  it("takes the user row lock before the passkey or recovery-code locks", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    enrollPasskey();
    fake.txLog = [];
    const removed = await call("DELETE", `/api/auth/mfa/passkeys/${fake.tables.passkeys[0]!.id}`, { password: PASSWORD }, asSuper());
    expect(removed.status).toBe(204);
    let ops = fake.txLog.map((e) => e.op);
    expect(ops[0]).toBe(USER_LOCK);
    expect(ops[1]).toBe("SELECT id::text AS id FROM user_passkeys WHERE user_id = $1::uuid FOR UPDATE");

    fake.txLog = [];
    const generated = await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
    expect(generated.status).toBe(200);
    ops = fake.txLog.map((e) => e.op);
    expect(ops[0]).toBe(USER_LOCK);
    expect(ops[1]).toBe("SELECT 1 FROM users WHERE id = $1::uuid FOR UPDATE");
    expect(new Set(fake.txLog.map((e) => e.tx)).size).toBe(1);
  });
});

// Finding: the management transactions rechecked only the password hash
// under the user row lock, so a request that passed requireCurrentPassword
// while the account was unlocked still added or removed a passkey, or
// replaced the recovery codes, after a concurrent failure locked it.
describe("MFA management rechecks lockout under the user row lock", () => {
  const USER_LOCK = "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE";
  const LOCKED_UNTIL = new Date(Date.now() + 30 * 60_000);
  const registration = {
    id: "bmV3LWNyZWRlbnRpYWw",
    rawId: "bmV3LWNyZWRlbnRpYWw",
    type: "public-key",
    response: { clientDataJSON: "e30", attestationObject: "o2NmbXRkbm9uZQ", transports: ["internal"] },
    clientExtensionResults: {}
  };
  const ROUTES = ["POST /passkeys", "DELETE /passkeys/:id", "POST /recovery-codes"] as const;
  type Route = (typeof ROUTES)[number];
  const SUCCESS: Record<Route, number> = {
    "POST /passkeys": 201,
    "DELETE /passkeys/:id": 204,
    "POST /recovery-codes": 200
  };

  // Set up the state the route changes (a register challenge, an enrolled
  // passkey, or an existing set of codes) and return the request to send.
  async function prepare(route: Route): Promise<() => Promise<Reply>> {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    if (route === "POST /passkeys") {
      expect((await call("POST", "/api/auth/mfa/passkeys/options", { password: PASSWORD }, asSuper())).status).toBe(200);
      fake.verifyRegistration.mockResolvedValueOnce({
        verified: true,
        registrationInfo: { credential: { id: registration.id, publicKey: new Uint8Array([4, 5, 6]), counter: 0 } }
      });
      return () => call("POST", "/api/auth/mfa/passkeys", { password: PASSWORD, response: registration }, asSuper());
    }
    if (route === "DELETE /passkeys/:id") {
      enrollPasskey();
      const id = fake.tables.passkeys[0]!.id;
      return () => call("DELETE", `/api/auth/mfa/passkeys/${id}`, { password: PASSWORD }, asSuper());
    }
    expect((await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).status).toBe(200);
    return () => call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper());
  }

  // Send the request with `change` committed after requireCurrentPassword's
  // unlocked check and before the management transaction takes the row
  // lock; expect the answer and no passkey, challenge or code write.
  async function expectRefusedUnderLock(route: Route, change: () => void, status: number, body: unknown) {
    const send = await prepare(route);
    const before = cloneTables(fake.tables);
    fake.audit.mockClear();
    fake.recordAuthFailure.mockClear();
    fake.auditInTx = [];
    fake.txLog = [];
    fake.beforeNextTransaction = change;
    const reply = await send();
    expect(reply.status).toBe(status);
    expect(reply.body).toEqual(body);
    expect(fake.verifyPassword).toHaveBeenLastCalledWith(PASSWORD, "stored-password-hash");
    expect(fake.txLog.map((e) => e.op)).toEqual([USER_LOCK]);
    expect(fake.tables).toEqual(before);
    expect(fake.recordAuthFailure).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
    expect(fake.auditInTx).toEqual([]);
  }

  it.each(ROUTES)("%s answers 429 and writes nothing when the account locked after the password check", async (route) => {
    await expectRefusedUnderLock(
      route,
      () => {
        fake.user.failedLoginCount = 0;
        fake.user.lockedUntil = LOCKED_UNTIL;
      },
      429,
      { error: "Too many failed attempts. Try again later." }
    );
    expect(fake.user.lockedUntil).toBe(LOCKED_UNTIL);
  });

  it.each(ROUTES)("%s answers 401 and writes nothing when the account was deactivated after the password check", async (route) => {
    await expectRefusedUnderLock(route, () => { fake.user.isActive = false; }, 401, { error: "Unauthorized" });
  });

  it.each(ROUTES)("%s still succeeds for a demo account with locked_until set", async (route) => {
    vi.stubEnv("DEMO_LOGIN_ACCOUNTS", JSON.stringify([
      { label: "Demo", email: SUPER.email, password: "synthetic-demo-password", role: "manager" }
    ]));
    fake.user.lockedUntil = LOCKED_UNTIL;
    const send = await prepare(route);
    const before = cloneTables(fake.tables);
    const reply = await send();
    expect(reply.status).toBe(SUCCESS[route]);
    expect(fake.tables).not.toEqual(before);
  });
});

// Findings: a passkey removed after its assertion was checked could still
// finish the login, and two concurrent assertions could lower the stored
// counter. The passkey row is reread under lock inside the completion
// transaction.
describe("passkey row checks under lock", () => {
  function verifiedWith(newCounter: number, before?: () => void) {
    fake.verifyAuthentication.mockImplementationOnce(async () => {
      before?.();
      return { verified: true, authenticationInfo: { credentialID: CREDENTIAL_ID, newCounter, userVerified: true } };
    });
  }

  function expectRejected(reply: Reply, reason: string) {
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.recordAuthFailure).toHaveBeenCalledWith(
      expect.objectContaining({ id: SUPER.id }),
      { factor: "passkey", sourceIp: "203.0.113.9" }
    );
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.mfa.verify",
      outcome: "denied",
      details: { authMethod: "local", factor: "passkey", reason }
    }));
  }

  it("refuses a passkey removed after its assertion verified and keeps the challenge", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    enrollPasskey();
    const { cookie } = await passwordStep();
    verifiedWith(7, () => { fake.tables.passkeys = []; });
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expectRejected(reply, "passkey_removed");
  });

  it("refuses a counter below the one stored meanwhile and never lowers sign_count", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    // A concurrent sign-in stored 9 after this assertion was checked against 3.
    verifiedWith(7, () => { fake.tables.passkeys[0]!.sign_count = 9; });
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expectRejected(reply, "counter_not_increased");
    expect(fake.tables.passkeys[0]!.sign_count).toBe(9);
    expect(fake.tables.passkeys[0]!.last_used_at).toBeNull();
  });

  it("refuses a counter equal to the stored one", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    verifiedWith(7, () => { fake.tables.passkeys[0]!.sign_count = 7; });
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expectRejected(reply, "counter_not_increased");
    expect(fake.tables.passkeys[0]!.sign_count).toBe(7);
  });

  it("refuses a 0 counter over a nonzero stored counter", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    verifiedWith(0);
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expectRejected(reply, "counter_not_increased");
    expect(fake.tables.passkeys[0]!.sign_count).toBe(3);
  });

  it("signs in when both counters are 0 (an authenticator that does not count)", async () => {
    enrollPasskey();
    fake.tables.passkeys[0]!.sign_count = 0;
    const { cookie } = await passwordStep();
    verifiedWith(0);
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply.status).toBe(200);
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeTruthy();
    expect(fake.tables.passkeys[0]!.sign_count).toBe(0);
    expect(fake.tables.passkeys[0]!.last_used_at).toBeInstanceOf(Date);
    expect(fake.tables.challenges[0]!.consumed_at).not.toBeNull();
  });
});

// Finding: a request that passed the unlocked isAccountLocked check could
// still create a session after a concurrent failure locked the account, and
// its recordAuthSuccess then cleared the lock. Lock state and is_active are
// read with the hash under the user row lock, and the lockout reset runs in
// the session transaction.
describe("lockout rechecked under the user row lock", () => {
  const USER_LOCK = "SELECT password_hash, is_active, locked_until FROM users WHERE id = $1::uuid FOR UPDATE";
  const LOCKED_UNTIL = new Date(Date.now() + 30 * 60_000);

  // A failure on another connection reaches the threshold and commits after
  // the request's unlocked checks, before its locking transaction.
  function lockBeforeTransaction() {
    fake.beforeNextTransaction = () => {
      fake.user.failedLoginCount = 0;
      fake.user.lockedUntil = LOCKED_UNTIL;
    };
  }

  function expectStillLocked() {
    expect(fake.user.lockedUntil).toBe(LOCKED_UNTIL);
    expect(fake.user.failedLoginCount).toBe(0);
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.recordAuthFailure).not.toHaveBeenCalled();
  }

  function lockingTxOps(): string[] {
    const first = fake.txLog.find((e) => e.op === USER_LOCK);
    expect(first).toBeDefined();
    return fake.txLog.filter((e) => e.tx === first!.tx).map((e) => e.op);
  }

  it("passkey: refuses with the generic 401, consumes nothing and leaves the lock", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    lockBeforeTransaction();
    fake.txLog = [];
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(reply.cookies.find((c) => c.startsWith("truenote_mfa="))).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.tables.passkeys[0]!.sign_count).toBe(3);
    expect(lockingTxOps()).toEqual([USER_LOCK]);
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expectStillLocked();
  });

  it("recovery code: refuses with the generic 401, spends no code and leaves the lock", async () => {
    const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
    enrollPasskey();
    const { cookie } = await passwordStep();
    lockBeforeTransaction();
    fake.txLog = [];
    const reply = await call("POST", "/api/auth/mfa/recovery-code", { code: codes[0] }, { cookie });
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(cookieValue(reply.cookies, SESSION_COOKIE_NAME)).toBeUndefined();
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
    expect(fake.tables.codes.every((r) => r.used_at === null)).toBe(true);
    expect(lockingTxOps()).toEqual([USER_LOCK]);
    expectStillLocked();
  });

  it("refuses an account deactivated after the unlocked check", async () => {
    enrollPasskey();
    const { cookie } = await passwordStep();
    fake.beforeNextTransaction = () => { fake.user.isActive = false; };
    const reply = await call("POST", "/api/auth/mfa/passkey", assertion, { cookie });
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.recordAuthSuccess).not.toHaveBeenCalled();
    expect(fake.tables.challenges[0]!.consumed_at).toBeNull();
  });

  it("password-only login: refuses with the generic 401 and an account_locked event, and leaves the lock", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    lockBeforeTransaction();
    const { reply } = await passwordStep();
    expect(reply).toMatchObject({ status: 401, body: { error: "Invalid credentials" } });
    expect(reply.cookies).toEqual([]);
    expect(fake.sessionInsert).not.toHaveBeenCalled();
    expect(fake.txLog.map((e) => e.op)).toEqual([USER_LOCK]);
    expect(fake.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.local.login",
      outcome: "denied",
      details: { authMethod: "local", reason: "account_locked" }
    }));
    expect(fake.audit).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "success" }));
    expectStillLocked();
  });

  it.each([
    ["passkey", "/api/auth/mfa/passkey"],
    ["recovery code", "/api/auth/mfa/recovery-code"],
    ["password-only login", "/api/auth/login"]
  ])("%s: resets the count on the session transaction, after the session insert", async (_name, path) => {
    let body: unknown;
    let headers: Record<string, string> = {};
    if (path === "/api/auth/login") {
      vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
      body = { email: SUPER.email, password: PASSWORD };
    } else {
      const codes = (await call("POST", "/api/auth/mfa/recovery-codes", { password: PASSWORD }, asSuper())).body!.codes as string[];
      enrollPasskey();
      const { cookie } = await passwordStep();
      headers = { cookie };
      body = path.endsWith("/passkey") ? assertion : { code: codes[0] };
    }
    const reply = await call("POST", path, body, headers);
    expect(reply.status).toBe(200);
    expect(fake.recordAuthSuccess).toHaveBeenCalledTimes(1);
    expect(fake.recordAuthSuccess).toHaveBeenCalledWith(SUPER.id, expect.objectContaining({ isTx: true }));
    expect(fake.sessionInsert).toHaveBeenCalledTimes(1);
    expect(fake.recordAuthSuccess.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(fake.sessionInsert.mock.invocationCallOrder[0]!);
  });
});
