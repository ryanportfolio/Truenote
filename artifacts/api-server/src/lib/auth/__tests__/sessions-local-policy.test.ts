import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessions } from "@workspace/db/schema";

const fake = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  fields: null as Record<string, unknown> | null
}));

vi.mock("../../db-client.js", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      fake.fields = fields;
      return {
        from: () => ({
          innerJoin: () => ({ where: () => ({ limit: async () => fake.rows }) })
        })
      };
    },
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    delete: () => ({ where: () => Promise.resolve(undefined) })
  }
}));

import { findSessionByToken } from "../sessions.js";

const oidcVariables = [
  "OIDC_ISSUER_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URI", "OIDC_STATE_SECRET", "LOCAL_LOGIN_MODE"
];

function sessionRow(role: string, authMethod: "local" | "oidc") {
  return {
    sessionId: "00000000-0000-4000-8000-000000000010",
    userId: "00000000-0000-4000-8000-000000000001",
    email: "person@example.com",
    role,
    programId: role === "super_user" ? null : "00000000-0000-4000-8000-000000000002",
    name: "Person",
    isActive: true,
    mustResetPassword: false,
    authMethod,
    lastUsedAt: new Date()
  };
}

beforeEach(() => {
  oidcVariables.forEach((name) => vi.stubEnv(name, undefined));
  fake.rows = [];
  fake.fields = null;
});
afterEach(() => vi.unstubAllEnvs());

async function lookup(mode: string, role: string, authMethod: "local" | "oidc") {
  vi.stubEnv("LOCAL_LOGIN_MODE", mode);
  fake.rows = [sessionRow(role, authMethod)];
  return findSessionByToken("synthetic-session-token");
}

describe("findSessionByToken applies LOCAL_LOGIN_MODE to local sessions", () => {
  it("reads the session's auth_method", async () => {
    await lookup("enabled", "csr", "local");
    expect(fake.fields?.authMethod).toBe(sessions.authMethod);
  });

  it.each(["csr", "supervisor", "manager"])("refuses a local %s session in break_glass", async (role) => {
    await expect(lookup("break_glass", role, "local")).resolves.toBeNull();
  });

  it.each(["csr", "super_user"])("refuses a local %s session in disabled", async (role) => {
    await expect(lookup("disabled", role, "local")).resolves.toBeNull();
  });

  it("refuses a local session when LOCAL_LOGIN_MODE is invalid", async () => {
    await expect(lookup("disable", "super_user", "local")).resolves.toBeNull();
  });

  it("allows a local super_user session in break_glass", async () => {
    await expect(lookup("break_glass", "super_user", "local")).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000001", role: "super_user"
    });
  });

  it.each(["csr", "super_user"])("allows a local %s session in enabled", async (role) => {
    await expect(lookup("enabled", role, "local")).resolves.toMatchObject({ role });
  });

  it.each(["csr", "super_user"])("allows an oidc %s session in disabled", async (role) => {
    await expect(lookup("disabled", role, "oidc")).resolves.toMatchObject({ role });
  });

  it("allows an oidc csr session in break_glass", async () => {
    await expect(lookup("break_glass", "csr", "oidc")).resolves.toMatchObject({ role: "csr" });
  });

  it("still refuses an inactive user's oidc session", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    fake.rows = [{ ...sessionRow("csr", "oidc"), isActive: false }];
    await expect(findSessionByToken("synthetic-session-token")).resolves.toBeNull();
  });
});
