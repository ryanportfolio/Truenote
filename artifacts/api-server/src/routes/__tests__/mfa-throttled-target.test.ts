import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import cookieParser from "cookie-parser";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POAM-2026-032: a second-factor attempt refused with 429 by either IP
// limiter (mfaLoginIpLimit or the in-handler loginIpLimiter) still names the
// targeted account in its http.security_mutation record when the request
// carries a valid MFA challenge cookie. The refusal reads the challenge once
// and checks no factor. Real MFA router, limiters and audit middleware; the
// database and audit writes are fakes.

const CHALLENGE_USER = "00000000-0000-4000-8000-0000000000a1";
const TOKEN = "synthetic-mfa-cookie-token";

const fake = vi.hoisted(() => ({
  audit: vi.fn(),
  sql: [] as string[],
  userReads: 0,
  loginIpAllowed: true
}));

const dialect = new PgDialect();

vi.mock("../../lib/db-client.js", () => ({
  db: {
    execute: async (query: SQL) => {
      const { sql: raw, params } = dialect.sqlToQuery(query);
      const text = raw.replace(/\s+/g, " ").trim();
      fake.sql.push(text);
      if (text.includes("FROM mfa_challenges") && text.includes("WHERE token_hash =")) {
        const valid = params[0] === createHash("sha256").update(TOKEN).digest("hex");
        return {
          rows: valid ? [{ id: "challenge-1", user_id: CHALLENGE_USER, challenge: "c" }] : []
        };
      }
      throw new Error(`unexpected SQL in test: ${text}`);
    },
    select: () => {
      fake.userReads += 1;
      throw new Error("a throttled attempt must not load the account");
    }
  }
}));
vi.mock("../../lib/security/audit.js", () => ({
  recordSecurityEventBestEffort: fake.audit,
  appendSecurityEvent: vi.fn()
}));
vi.mock("../../lib/auth/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth/rate-limit.js")>()),
  loginIpLimiter: { hit: () => fake.loginIpAllowed }
}));

import { mfaRouter } from "../mfa.js";
import { mfaLoginIpLimit } from "../../lib/security/route-rate-limit.js";
import { securityAuditMiddleware } from "../../middleware/security-audit.js";

const THROTTLED = { error: "Too many login attempts. Try again in a few minutes." };
const ROUTES = ["/passkey", "/recovery-code"] as const;

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", securityAuditMiddleware);
  app.use("/api/auth/mfa", mfaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  vi.clearAllMocks();
  fake.sql = [];
  fake.userReads = 0;
  fake.loginIpAllowed = true;
});

async function attempt(path: string, ip: string, cookie?: string) {
  const res = await fetch(`${base}/api/auth/mfa${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": ip,
      ...(cookie ? { cookie: `truenote_mfa=${cookie}` } : {})
    },
    body: "{}"
  });
  return { status: res.status, body: await res.json() };
}

/** The audit middleware's record of the one request sent since the last clear. */
async function mutationDetails(): Promise<Record<string, unknown>> {
  await vi.waitFor(() => expect(fake.audit).toHaveBeenCalled());
  const events = fake.audit.mock.calls.map(([event]) => event);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ action: "http.security_mutation", outcome: "denied" });
  return events[0].details;
}

describe("throttled second-factor attempt", () => {
  it.each(ROUTES)("%s: loginIpLimiter refusal names the challenge's account", async (path) => {
    fake.loginIpAllowed = false;
    mfaLoginIpLimit.resetKey("198.51.100.31");
    const reply = await attempt(path, "198.51.100.31", TOKEN);
    expect(reply).toEqual({ status: 429, body: THROTTLED });
    expect(await mutationDetails()).toMatchObject({ status: 429, targetUserId: CHALLENGE_USER });
    // One read of the challenge; the account is not loaded and no factor runs.
    expect(fake.sql).toHaveLength(1);
    expect(fake.userReads).toBe(0);
  });

  it.each(ROUTES)("%s: loginIpLimiter refusal without a valid challenge names no account", async (path) => {
    fake.loginIpAllowed = false;
    mfaLoginIpLimit.resetKey("198.51.100.32");
    const unknown = await attempt(path, "198.51.100.32", "not-a-live-challenge");
    expect(unknown).toEqual({ status: 429, body: THROTTLED });
    expect(await mutationDetails()).not.toHaveProperty("targetUserId");

    fake.audit.mockClear();
    fake.sql = [];
    const none = await attempt(path, "198.51.100.32");
    expect(none).toEqual(unknown);
    expect(await mutationDetails()).not.toHaveProperty("targetUserId");
    expect(fake.sql).toEqual([]);
  });

  it("mfaLoginIpLimit refusal names the challenge's account on both routes", async () => {
    const ip = "198.51.100.33";
    mfaLoginIpLimit.resetKey(ip);
    // Spend the budget without a cookie: each stops at the missing challenge
    // with no database read.
    for (let batch = 0; batch < 20; batch += 1) {
      const replies = await Promise.all(
        Array.from({ length: 100 }, (_, i) => attempt(ROUTES[i % 2]!, ip))
      );
      expect(new Set(replies.map((r) => r.status))).toEqual(new Set([401]));
    }
    expect(fake.sql).toEqual([]);

    for (const path of ROUTES) {
      fake.audit.mockClear();
      fake.sql = [];
      const reply = await attempt(path, ip, TOKEN);
      expect(reply).toEqual({ status: 429, body: THROTTLED });
      expect(await mutationDetails()).toMatchObject({ status: 429, targetUserId: CHALLENGE_USER });
      expect(fake.sql).toHaveLength(1);
      expect(fake.userReads).toBe(0);

      fake.audit.mockClear();
      const unknown = await attempt(path, ip, "not-a-live-challenge");
      expect(unknown).toEqual(reply);
      expect(await mutationDetails()).not.toHaveProperty("targetUserId");
    }
  }, 60_000);
});
