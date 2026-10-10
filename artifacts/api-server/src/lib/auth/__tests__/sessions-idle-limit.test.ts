import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// One session row held in memory. The fake db applies the real code's
// UPDATE (last_used_at touch) and DELETE to it, so a sequence of requests
// over a faked clock behaves like the database would.
const fake = vi.hoisted(() => ({
  row: null as null | {
    sessionId: string;
    userId: string;
    email: string;
    role: string;
    programId: string | null;
    name: string;
    isActive: boolean;
    mustResetPassword: boolean;
    authMethod: "local" | "oidc";
    lastUsedAt: Date;
    expiresAt: Date;
  },
  touches: 0,
  deletes: 0
}));

vi.mock("../../db-client.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => {
              const row = fake.row;
              if (!row || row.expiresAt.getTime() <= Date.now()) return [];
              return [{ ...row }];
            }
          })
        })
      })
    }),
    update: () => ({
      set: (values: { lastUsedAt?: Date }) => ({
        where: async () => {
          fake.touches += 1;
          if (fake.row && values.lastUsedAt) fake.row.lastUsedAt = values.lastUsedAt;
        }
      })
    }),
    delete: () => ({
      where: async () => {
        fake.deletes += 1;
        fake.row = null;
      }
    })
  }
}));

import { findSessionByToken } from "../sessions.js";
import { attachCurrentUser } from "../../../middleware/current-user.js";

const MINUTE = 60 * 1000;
const start = new Date("2026-10-10T12:00:00Z");

function seed(authMethod: "local" | "oidc", role = "csr") {
  fake.row = {
    sessionId: "00000000-0000-4000-8000-000000000010",
    userId: "00000000-0000-4000-8000-000000000001",
    email: "person@example.com",
    role,
    programId: role === "super_user" ? null : "00000000-0000-4000-8000-000000000002",
    name: "Person",
    isActive: true,
    mustResetPassword: false,
    authMethod,
    lastUsedAt: new Date(Date.now()),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * MINUTE)
  };
}

function advance(ms: number) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** Run attachCurrentUser for one request and return the resolved user. */
async function request(headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])
  );
  const req = {
    cookies: { kbase_session: "synthetic-session-token" },
    get: (name: string) => lower[name.toLowerCase()],
    user: undefined
  } as unknown as Request;
  const next = vi.fn() as unknown as NextFunction;
  await attachCurrentUser(req, {} as Response, next);
  expect(next).toHaveBeenCalledTimes(1);
  // Let the fire-and-forget last_used_at touch settle.
  await Promise.resolve();
  await Promise.resolve();
  return req.user;
}

const background = { "X-Truenote-Background": "1" };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  [
    "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI",
    "OIDC_STATE_SECRET", "LOCAL_LOGIN_MODE", "SESSION_IDLE_MINUTES"
  ].forEach((name) => vi.stubEnv(name, undefined));
  vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
  fake.row = null;
  fake.touches = 0;
  fake.deletes = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("idle limit on oidc sessions", () => {
  it("refuses and deletes an oidc session idle past 15 minutes", async () => {
    seed("oidc");
    advance(16 * MINUTE);
    await expect(findSessionByToken("synthetic-session-token")).resolves.toBeNull();
    expect(fake.deletes).toBe(1);
    expect(fake.row).toBeNull();
    expect(fake.touches).toBe(0);
  });

  it("keeps an oidc session inside the idle window", async () => {
    seed("oidc");
    advance(14 * MINUTE);
    await expect(findSessionByToken("synthetic-session-token")).resolves.toMatchObject({
      role: "csr"
    });
    expect(fake.deletes).toBe(0);
  });

  it("is refreshed by normal requests", async () => {
    seed("oidc");
    for (let step = 0; step < 4; step += 1) {
      advance(10 * MINUTE);
      expect(await request()).toMatchObject({ email: "person@example.com" });
    }
    expect(fake.row?.lastUsedAt.getTime()).toBe(start.getTime() + 40 * MINUTE);
    expect(fake.deletes).toBe(0);
  });

  it("is not refreshed by background requests, so it expires", async () => {
    seed("oidc");
    advance(10 * MINUTE);
    expect(await request(background)).toMatchObject({ email: "person@example.com" });
    expect(fake.touches).toBe(0);
    expect(fake.row?.lastUsedAt.getTime()).toBe(start.getTime());
    advance(6 * MINUTE);
    expect(await request(background)).toBeNull();
    expect(fake.deletes).toBe(1);
  });

  it("treats only the exact header value 1 as background", async () => {
    seed("oidc");
    advance(MINUTE);
    await request({ "X-Truenote-Background": "true" });
    expect(fake.touches).toBe(1);
  });

  it("follows SESSION_IDLE_MINUTES", async () => {
    vi.stubEnv("SESSION_IDLE_MINUTES", "30");
    seed("oidc");
    advance(20 * MINUTE);
    expect(await request()).not.toBeNull();
    advance(31 * MINUTE);
    expect(await request()).toBeNull();
  });
});

describe("idle limit on local sessions", () => {
  it("does not idle-limit a local session while LOCAL_LOGIN_MODE is enabled", async () => {
    seed("local", "csr");
    advance(6 * 60 * MINUTE);
    expect(await request()).toMatchObject({ role: "csr" });
    expect(fake.deletes).toBe(0);
  });

  it("idle-limits the local super_user session in break_glass", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    seed("local", "super_user");
    advance(10 * MINUTE);
    expect(await request()).toMatchObject({ role: "super_user" });
    advance(16 * MINUTE);
    expect(await request()).toBeNull();
    expect(fake.deletes).toBe(1);
  });
});
