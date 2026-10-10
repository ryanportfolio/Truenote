import type { Request, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../../lib/auth/current-user.js";

const PROGRAM_ID = "00000000-0000-4000-8000-0000000000a1";

const fake = vi.hoisted(() => ({
  createResetToken: vi.fn(),
  send: vi.fn(),
  hashPassword: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>
}));

function returnedRow(values: Record<string, unknown>) {
  return {
    id: `00000000-0000-4000-8000-${String(fake.inserted.length).padStart(12, "0")}`,
    email: values.email,
    name: values.name,
    role: values.role,
    programId: values.programId,
    isActive: true,
    mustResetPassword: values.mustResetPassword,
    lastLoginAt: null,
    createdAt: new Date("2026-10-10T00:00:00Z")
  };
}

function insertChain() {
  return {
    values(values: Record<string, unknown>) {
      fake.inserted.push(values);
      const rows = [returnedRow(values)];
      return {
        returning: async () => rows,
        onConflictDoNothing: () => ({ returning: async () => rows })
      };
    }
  };
}

vi.mock("../../lib/db-client.js", () => ({
  db: {
    insert: () => insertChain(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ insert: () => insertChain() })
  }
}));
vi.mock("../../lib/auth/passwords.js", () => ({
  hashPassword: fake.hashPassword,
  verifyPassword: vi.fn()
}));
vi.mock("../../lib/auth/password-reset.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/password-reset.js")>(),
  createResetToken: fake.createResetToken
}));
vi.mock("../../lib/email/sender.js", () => ({
  getEmailSender: () => ({ send: fake.send }),
  isEmailDeliveryConfigured: () => true
}));
vi.mock("../../lib/observability/error-log.js", () => ({
  recordAppError: vi.fn(async () => undefined)
}));

const { usersRouter } = await import("../admin/users.js");

type Handler = (req: Request, res: Response, next: (err?: unknown) => void) => unknown;

/** The route's final handler, past the rate limits and role guard. */
function handler(router: Router, path: string): Handler {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.post)?.route;
  expect(route, `POST ${path} must be mounted`).toBeDefined();
  return route!.stack[route!.stack.length - 1]!.handle;
}

function actor(role: CurrentUser["role"]): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-0000000000f1",
    email: "admin@example.com",
    role,
    programId: role === "super_user" ? null : PROGRAM_ID,
    name: "Admin",
    mustResetPassword: false
  } as CurrentUser;
}

async function call(path: string, user: CurrentUser, body: unknown) {
  const result = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(payload: unknown) {
      result.body = payload;
      return res;
    }
  } as unknown as Response;
  const req = {
    body,
    user,
    header: () => undefined,
    get: () => undefined,
    protocol: "https"
  } as unknown as Request;
  let failure: unknown;
  await handler(usersRouter, path)(req, res, (err) => {
    failure = err;
  });
  if (failure) throw failure;
  return result as { status: number; body: Record<string, unknown> };
}

beforeEach(() => {
  fake.inserted = [];
  fake.hashPassword.mockReset().mockResolvedValue("argon2-hash");
  fake.send.mockReset().mockResolvedValue(undefined);
  fake.createResetToken
    .mockReset()
    .mockResolvedValue({ token: "synthetic-invite-token", expiresAt: new Date("2026-10-17T00:00:00Z") });
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const csrBody = { email: "New.Person@example.com", name: "New Person", role: "csr", programId: PROGRAM_ID };

describe("POST /api/admin/users invitation by login mode", () => {
  it("keeps the temp password flow when local login is enabled", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    const result = await call("/", actor("manager"), csrBody);
    expect(result.status).toBe(201);
    expect(typeof result.body.tempPassword).toBe("string");
    expect(result.body.invitation).toBeUndefined();
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.createResetToken).not.toHaveBeenCalled();
  });

  it.each(["break_glass", "disabled"])(
    "emails an SSO user a sign-in link and returns no password under %s",
    async (mode) => {
      vi.stubEnv("LOCAL_LOGIN_MODE", mode);
      const result = await call("/", actor("manager"), csrBody);
      expect(result.status).toBe(201);
      expect(result.body.tempPassword).toBeUndefined();
      expect(result.body.invitation).toEqual({ kind: "sso", emailSent: true });
      expect(fake.createResetToken).not.toHaveBeenCalled();
      expect(fake.send).toHaveBeenCalledTimes(1);
      const email = fake.send.mock.calls[0]![0] as { to: string; text: string; html: string };
      expect(email.to).toBe("new.person@example.com");
      expect(email.text).toContain("https://app.example.com/login");
      expect(email.text).toContain("Continue with company SSO");
      expect(email.text).not.toContain("reset-password");
      expect(email.html).not.toContain("reset-password");
      // The stored hash comes from a random value nobody is shown.
      const hashed = fake.hashPassword.mock.calls[0]![0] as string;
      expect(JSON.stringify(result.body)).not.toContain(hashed);
    }
  );

  it("refuses a caller-supplied password for an SSO user", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    const result = await call("/", actor("manager"), {
      ...csrBody,
      password: "synthetic-password-long-enough"
    });
    expect(result.status).toBe(400);
    expect(fake.inserted).toHaveLength(0);
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("keeps the temp password for the break-glass super user", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    const result = await call("/", actor("super_user"), {
      email: "emergency@example.com",
      name: "Emergency",
      role: "super_user",
      programId: null
    });
    expect(result.status).toBe(201);
    expect(typeof result.body.tempPassword).toBe("string");
    expect(result.body.invitation).toBeUndefined();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("answers within the send deadline when the email provider stalls", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    fake.send.mockReturnValueOnce(new Promise(() => undefined));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = call("/", actor("manager"), csrBody);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.status).toBe(201);
      expect(result.body.invitation).toEqual({ kind: "sso", emailSent: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates the SSO account and reports an unsent email when the send fails", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    fake.send.mockRejectedValueOnce(new Error("provider down"));
    const result = await call("/", actor("manager"), csrBody);
    expect(result.status).toBe(201);
    expect(result.body.invitation).toEqual({ kind: "sso", emailSent: false });
    expect(result.body.tempPassword).toBeUndefined();
  });
});

describe("POST /api/admin/users/bulk invitation by login mode", () => {
  const bulkBody = { emails: ["a.one@example.com", "b.two@example.com"] };

  it("mints setup tokens and sends /reset-password links when local login is enabled", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    const result = await call("/bulk", actor("manager"), bulkBody);
    expect(result.status).toBe(201);
    expect(result.body.invitationKind).toBe("password_setup");
    expect(result.body.invitedCount).toBe(2);
    expect(fake.createResetToken).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));
    for (const [email] of fake.send.mock.calls as Array<[{ text: string }]>) {
      expect(email.text).toContain("https://app.example.com/reset-password?token=synthetic-invite-token");
    }
  });

  it("mints no token and sends sign-in links under break_glass", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    const result = await call("/bulk", actor("manager"), bulkBody);
    expect(result.status).toBe(201);
    expect(result.body.invitationKind).toBe("sso");
    expect(result.body.invitedCount).toBe(2);
    expect(fake.createResetToken).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(2));
    const recipients = (fake.send.mock.calls as Array<[{ to: string; text: string }]>).map(([email]) => {
      expect(email.text).toContain("https://app.example.com/login");
      expect(email.text).toContain("Continue with company SSO");
      expect(email.text).not.toContain("reset-password");
      return email.to;
    });
    expect(recipients).toEqual(bulkBody.emails);
  });
});
