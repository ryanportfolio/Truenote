import { afterEach, describe, it, expect } from "vitest";
import {
  isDemoEmail,
  parseDemoAccounts,
  toPublicDemoAccounts
} from "../demo-accounts.js";

const VALID = JSON.stringify([
  { label: "Manager", email: "manager@demo.truenote", password: "pw1", role: "manager" },
  { label: "CSR", email: "csr@demo.truenote", password: "pw2" }
]);

describe("parseDemoAccounts", () => {
  it("returns null when unset or blank", () => {
    expect(parseDemoAccounts(undefined)).toBeNull();
    expect(parseDemoAccounts("")).toBeNull();
    expect(parseDemoAccounts("   ")).toBeNull();
  });

  it("returns null on invalid JSON", () => {
    expect(parseDemoAccounts("not json")).toBeNull();
  });

  it("returns null on schema violations", () => {
    expect(parseDemoAccounts(JSON.stringify([{ email: "x@y.z" }]))).toBeNull();
    expect(parseDemoAccounts(JSON.stringify([]))).toBeNull();
  });

  it("rejects roles above manager — demo creds must never grant admin capability", () => {
    const escalated = JSON.stringify([
      { label: "Root", email: "root@demo.truenote", password: "pw", role: "super_user" }
    ]);
    expect(parseDemoAccounts(escalated)).toBeNull();
  });

  it("parses valid accounts with defaults applied", () => {
    const accounts = parseDemoAccounts(VALID);
    expect(accounts).toHaveLength(2);
    expect(accounts?.[0]?.role).toBe("manager");
    expect(accounts?.[1]?.role).toBe("csr");
    expect(accounts?.[1]?.program).toBe("Demo Program");
  });

  it("strips role and program from the public shape", () => {
    const accounts = parseDemoAccounts(VALID);
    expect(accounts).not.toBeNull();
    if (!accounts) return;
    const publicAccounts = toPublicDemoAccounts(accounts);
    expect(publicAccounts[0]).toEqual({
      label: "Manager",
      email: "manager@demo.truenote",
      password: "pw1"
    });
  });
});

describe("isDemoEmail", () => {
  const ORIGINAL = process.env.DEMO_LOGIN_ACCOUNTS;

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.DEMO_LOGIN_ACCOUNTS;
    } else {
      process.env.DEMO_LOGIN_ACCOUNTS = ORIGINAL;
    }
  });

  it("is always false when demo mode is off", () => {
    delete process.env.DEMO_LOGIN_ACCOUNTS;
    expect(isDemoEmail("manager@demo.truenote")).toBe(false);
  });

  it("matches configured demo emails case-insensitively", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = VALID;
    expect(isDemoEmail("manager@demo.truenote")).toBe(true);
    expect(isDemoEmail("MANAGER@Demo.Truenote")).toBe(true);
    expect(isDemoEmail("csr@demo.truenote")).toBe(true);
    expect(isDemoEmail("real.admin@company.com")).toBe(false);
  });

  it("tracks env changes rather than caching the first value forever", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = VALID;
    expect(isDemoEmail("csr@demo.truenote")).toBe(true);
    process.env.DEMO_LOGIN_ACCOUNTS = JSON.stringify([
      { label: "Other", email: "other@demo.truenote", password: "pw" }
    ]);
    expect(isDemoEmail("csr@demo.truenote")).toBe(false);
    expect(isDemoEmail("other@demo.truenote")).toBe(true);
  });
});
