import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// POAM-2026-032 and POAM-2026-027: the audit record of a denied password
// sign-in (securityAuditMiddleware's http.security_mutation event) names the
// targeted account, by user id when it exists and by a SHA-256 hash of the
// submitted identifier when it does not, and carries the address from
// X-Real-IP. The real router, middleware and client-address helper run in
// an Express app; the database, password hashing and audit writes are fakes.

const fake = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  audit: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn()
}));

vi.mock("../../lib/db-client.js", () => {
  // recordAuthFailure's UPDATE ... RETURNING finds nothing to count.
  const update = () => ({
    set: () => ({
      where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [] })
    })
  });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => fake.rows }) }) }),
      update
    }
  };
});
vi.mock("../../lib/auth/passwords.js", () => ({
  verifyPassword: fake.verifyPassword,
  hashPassword: fake.hashPassword
}));
vi.mock("../../lib/security/audit.js", () => ({ recordSecurityEventBestEffort: fake.audit }));

import { authRouter } from "../auth.js";
import { securityAuditMiddleware } from "../../middleware/security-audit.js";

const USER = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "person@example.com",
  passwordHash: "stored-password-hash",
  role: "csr",
  programId: "00000000-0000-4000-8000-000000000002",
  name: "Person",
  isActive: true,
  mustResetPassword: false,
  lockedUntil: null
};
const PASSWORD = "Tr0ub4dor&3-secret";

let server: Server;
let base = "";

beforeAll(async () => {
  for (const name of ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET", "DEMO_LOGIN_ACCOUNTS"]) {
    vi.stubEnv(name, "");
  }
  vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
  const app = express();
  app.use(express.json());
  app.use("/api/auth", securityAuditMiddleware);
  app.use("/api/auth", authRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  fake.rows = [];
  fake.hashPassword.mockResolvedValue("dummy-password-hash");
  fake.verifyPassword.mockResolvedValue(false);
});

async function login(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.50", ...headers },
    body: JSON.stringify(body)
  });
  const reply = { status: res.status, body: await res.json() };
  // The middleware writes its event when the response finishes.
  await vi.waitFor(() => expect(mutationEvent()).toBeDefined());
  return reply;
}

function mutationEvent() {
  return fake.audit.mock.calls
    .map(([event]) => event)
    .find((event) => event.action === "http.security_mutation");
}

function sha256(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("denied sign-in audit record", () => {
  it("records the user id for an existing account", async () => {
    fake.rows = [{ ...USER }];
    const reply = await login({ email: USER.email, password: PASSWORD });
    expect(reply).toEqual({ status: 401, body: { error: "Invalid credentials" } });
    const event = mutationEvent();
    expect(event).toMatchObject({
      outcome: "denied",
      resourceId: "POST /api/auth/login",
      details: { status: 401, targetUserId: USER.id }
    });
    expect(event.details).not.toHaveProperty("targetIdentifierSha256");
  });

  it("records the user id for a deactivated account", async () => {
    fake.rows = [{ ...USER, isActive: false }];
    await login({ email: USER.email, password: PASSWORD });
    expect(mutationEvent().details).toMatchObject({ targetUserId: USER.id });
  });

  it("records only a hash of the normalized identifier for an unknown account", async () => {
    const reply = await login({ email: "  Ghost@Example.COM ", password: PASSWORD });
    expect(reply).toEqual({ status: 401, body: { error: "Invalid credentials" } });
    const event = mutationEvent();
    expect(event.details).toMatchObject({ targetIdentifierSha256: sha256("ghost@example.com") });
    expect(event.details).not.toHaveProperty("targetUserId");
    const recorded = JSON.stringify(fake.audit.mock.calls).toLowerCase();
    expect(recorded).not.toContain("ghost@example.com");
    expect(recorded).not.toContain(PASSWORD.toLowerCase());
  });

  it("never records a password typed into the email field", async () => {
    const reply = await login({ email: PASSWORD, password: "x" });
    expect(reply.status).toBe(400);
    expect(mutationEvent().details).toMatchObject({
      status: 400,
      targetIdentifierSha256: sha256(PASSWORD.toLowerCase())
    });
    expect(JSON.stringify(fake.audit.mock.calls).toLowerCase()).not.toContain(PASSWORD.toLowerCase());
  });

  it("answers an unknown and an existing account the same way", async () => {
    const unknown = await login({ email: "ghost@example.com", password: PASSWORD });
    fake.audit.mockClear();
    fake.rows = [{ ...USER }];
    const existing = await login({ email: USER.email, password: PASSWORD });
    expect(unknown).toEqual(existing);
  });

  it("takes the address from X-Real-IP, not a spoofed X-Forwarded-For", async () => {
    await login(
      { email: "ghost@example.com", password: PASSWORD },
      { "x-forwarded-for": "198.51.100.1, 203.0.113.50" }
    );
    expect(mutationEvent().sourceIp).toBe("203.0.113.50");
  });
});
