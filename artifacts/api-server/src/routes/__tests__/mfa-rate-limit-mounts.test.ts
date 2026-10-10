import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Router } from "express";
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../../lib/auth/current-user.js";

// CodeQL js/missing-rate-limiting on routes/mfa.ts: the real router with the
// real express-rate-limit limiters from lib/security/route-rate-limit.ts.
// The older in-handler loginIpLimiter is switched off here, so a 429 can
// only come from the new limiter. No request in this file reaches the
// database: the login step without an MFA cookie stops at the missing
// challenge, and a manager stops at requireSuperUser.
vi.mock("../../lib/auth/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth/rate-limit.js")>()),
  loginIpLimiter: { hit: () => true }
}));

import { mfaRouter } from "../mfa.js";
import { mfaLoginIpLimit, mfaManageLimit } from "../../lib/security/route-rate-limit.js";
import { requireAuth, requireSuperUser } from "../../middleware/current-user.js";

const MANAGER: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000c1",
  email: "manager@example.com",
  role: "manager",
  programId: null,
  name: "Manager",
  mustResetPassword: false
};

type Handler = (...args: unknown[]) => unknown;

function routeHandlers(router: Router, method: string, path: string): Handler[] {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method.toLowerCase()] === true);
  expect(layer, `${method} ${path} must be mounted`).toBeDefined();
  return layer?.route?.stack.map((entry) => entry.handle) ?? [];
}

const LOGIN_ROUTES = [["POST", "/passkey"], ["POST", "/recovery-code"]] as const;
const MANAGE_ROUTES = [
  ["GET", "/status"],
  ["POST", "/passkeys/options"],
  ["POST", "/passkeys"],
  ["DELETE", "/passkeys/:id"],
  ["POST", "/recovery-codes"]
] as const;

let server: Server;
let base = "";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => {
    req.user = req.header("x-test-user") === MANAGER.id ? MANAGER : null;
    next();
  });
  app.use("/api/auth/mfa", mfaRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function send(method: string, path: string, headers: Record<string, string>) {
  const res = await fetch(`${base}/api/auth/mfa${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: method === "GET" ? undefined : "{}"
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("limiter placement", () => {
  it.each(LOGIN_ROUTES)("%s %s runs the per-IP limiter first", (method, path) => {
    expect(routeHandlers(mfaRouter, method, path)[0]).toBe(mfaLoginIpLimit);
  });

  it.each(MANAGE_ROUTES)("%s %s runs the per-user limiter right after requireAuth", (method, path) => {
    const handlers = routeHandlers(mfaRouter, method, path);
    expect(handlers[0]).toBe(requireAuth);
    expect(handlers[1]).toBe(mfaManageLimit);
    expect(handlers[2]).toBe(requireSuperUser);
  });
});

describe("over the limit", () => {
  it("answers 429 on both login-step routes once one IP used 2000 requests", async () => {
    const ip = { "x-forwarded-for": "198.51.100.23" };
    let statuses: number[] = [];
    for (let batch = 0; batch < 20; batch += 1) {
      const replies = await Promise.all(
        Array.from({ length: 100 }, (_, i) => send("POST", (batch + i) % 2 === 0 ? "/passkey" : "/recovery-code", ip))
      );
      statuses = statuses.concat(replies.map((r) => r.status));
    }
    // Under the limit the step itself answers (no MFA cookie: expired).
    expect(new Set(statuses)).toEqual(new Set([401]));

    for (const [method, path] of LOGIN_ROUTES) {
      const limited = await send(method, path, ip);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: "Too many login attempts. Try again in a few minutes." });
      expect(limited.headers.get("ratelimit-policy")).toMatch(/^2000;w=600/);
    }

    // Another address keeps its own budget.
    expect((await send("POST", "/passkey", { "x-forwarded-for": "198.51.100.24" })).status).toBe(401);
  }, 60_000);

  it("answers 429 on every management route after 30 requests a minute from one user", async () => {
    const asManager = { "x-test-user": MANAGER.id };
    const paths = MANAGE_ROUTES.map(([method, path]) => [method, path.replace(":id", "00000000-0000-4000-8000-000000000001")] as const);
    for (const [method, path] of paths) {
      mfaManageLimit.resetKey(MANAGER.id);
      for (let i = 0; i < 30; i += 1) {
        // Under the limit the request goes on to requireSuperUser.
        expect((await send(method, path, asManager)).status).toBe(403);
      }
      const limited = await send(method, path, asManager);
      expect(limited.status).toBe(429);
      expect(limited.body).toEqual({ error: "Too many requests. Wait a minute and try again." });
    }

    // A signed-out caller is refused by requireAuth before the limiter.
    expect((await send("GET", "/status", {})).status).toBe(401);
  }, 60_000);
});
