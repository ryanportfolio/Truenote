import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express, { type Router } from "express";
import cookieParser from "cookie-parser";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CodeQL js/missing-rate-limiting on POST /login (routes/auth.ts) and the
// SSO routes (routes/oidc.ts): the real routers with the real
// express-rate-limit limiters from lib/security/route-rate-limit.ts. The
// older in-handler loginIpLimiter is switched off here, so a refusal can
// only come from the new limiters. No request in this file reaches the
// database: login with an empty body stops at the body check (400), and
// with SSO not configured /start answers 503 and /callback redirects to
// the login page before any query.
vi.mock("../../lib/auth/rate-limit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/auth/rate-limit.js")>()),
  loginIpLimiter: { hit: () => true }
}));

import { authRouter } from "../auth.js";
import { oidcRouter } from "../oidc.js";
import { loginPasswordIpLimit, oidcIpLimit } from "../../lib/security/route-rate-limit.js";

type Handler = (...args: unknown[]) => unknown;

function routeHandlers(router: Router, method: string, path: string): Handler[] {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method.toLowerCase()] === true);
  expect(layer, `${method} ${path} must be mounted`).toBeDefined();
  return layer?.route?.stack.map((entry) => entry.handle) ?? [];
}

const OIDC_ROUTES = ["/start", "/callback"] as const;
const SSO_ERROR = "/login?sso_error=1";

let server: Server;
let base = "";

beforeAll(async () => {
  // SSO stays unconfigured whatever the shell has set.
  for (const name of ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET"]) {
    vi.stubEnv(name, "");
  }
  // The callback logs every failed attempt; keep the 2000 requests quiet.
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  app.use("/api/auth/oidc", oidcRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function login(ip: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: "{}"
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function sso(path: string, ip: string) {
  const res = await fetch(`${base}/api/auth/oidc${path}`, {
    headers: { "x-forwarded-for": ip },
    redirect: "manual"
  });
  await res.arrayBuffer();
  return {
    status: res.status,
    location: res.headers.get("location"),
    // The callback handler always clears the state cookie; the limiter
    // answers before the handler runs, so it sets no cookie.
    clearsState: (res.headers.get("set-cookie") ?? "").includes("truenote_oidc_state="),
    headers: res.headers
  };
}

describe("limiter placement", () => {
  it("POST /login runs the per-IP limiter first", () => {
    expect(routeHandlers(authRouter, "POST", "/login")[0]).toBe(loginPasswordIpLimit);
  });

  it.each(OIDC_ROUTES)("GET %s runs the per-IP SSO limiter first", (path) => {
    expect(routeHandlers(oidcRouter, "GET", path)[0]).toBe(oidcIpLimit);
  });
});

describe("over the limit", () => {
  it("answers 429 on POST /login once one IP used 2000 requests", async () => {
    const ip = "198.51.100.31";
    let statuses: number[] = [];
    for (let batch = 0; batch < 20; batch += 1) {
      const replies = await Promise.all(Array.from({ length: 100 }, () => login(ip)));
      statuses = statuses.concat(replies.map((r) => r.status));
    }
    // Under the limit the handler itself answers (empty body: 400).
    expect(new Set(statuses)).toEqual(new Set([400]));

    const limited = await login(ip);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many login attempts. Try again in a few minutes." });
    expect(limited.headers.get("ratelimit-policy")).toMatch(/^2000;w=600/);

    // Another address keeps its own budget.
    expect((await login("198.51.100.32")).status).toBe(400);
  }, 60_000);

  it("redirects both SSO routes to the login page's SSO error once one IP used 2000 requests between them", async () => {
    const ip = "198.51.100.33";
    const replies: Awaited<ReturnType<typeof sso>>[] = [];
    for (let batch = 0; batch < 20; batch += 1) {
      replies.push(...(await Promise.all(
        Array.from({ length: 100 }, (_, i) => sso(OIDC_ROUTES[(batch + i) % 2], ip))
      )));
    }
    // Under the limit the handlers answer: /start 503 (SSO not configured),
    // /callback its own failure redirect, which clears the state cookie.
    const starts = replies.filter((_, n) => (Math.floor(n / 100) + (n % 100)) % 2 === 0);
    const callbacks = replies.filter((_, n) => (Math.floor(n / 100) + (n % 100)) % 2 === 1);
    expect(starts).toHaveLength(1000);
    expect(callbacks).toHaveLength(1000);
    expect(new Set(starts.map((r) => r.status))).toEqual(new Set([503]));
    expect(callbacks.every((r) => r.status === 302 && r.location === SSO_ERROR && r.clearsState)).toBe(true);

    for (const path of OIDC_ROUTES) {
      const limited = await sso(path, ip);
      expect(limited.status).toBe(302);
      expect(limited.location).toBe(SSO_ERROR);
      expect(limited.clearsState).toBe(false);
      expect(limited.headers.get("ratelimit-policy")).toMatch(/^2000;w=600/);
    }

    // Another address keeps its own budget.
    expect((await sso("/start", "198.51.100.34")).status).toBe(503);
    const other = await sso("/callback", "198.51.100.34");
    expect(other.status).toBe(302);
    expect(other.clearsState).toBe(true);
  }, 60_000);
});
