import type { Request, Response, Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "../../lib/auth/current-user.js";

const PROGRAM_ID = "00000000-0000-4000-8000-0000000000a1";
const TARGET_ID = "00000000-0000-4000-8000-0000000000c1";

const fake = vi.hoisted(() => ({
  target: null as Record<string, unknown> | null,
  updates: [] as Array<Record<string, unknown>>,
  deletes: 0,
  forgotRows: [] as Array<Record<string, unknown>>,
  createResetToken: vi.fn(),
  send: vi.fn(),
  invalidateMfa: vi.fn()
}));

vi.mock("../../lib/db-client.js", () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => fake.forgotRows }) })
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => (fake.target ? [fake.target] : []) })
            })
          })
        }),
        // Team membership for a supervisor actor: always on the team here.
        execute: async () => ({ rows: [{ found: 1 }] }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              fake.updates.push(values);
            }
          })
        }),
        delete: () => ({
          where: async () => {
            fake.deletes += 1;
          }
        })
      })
  }
}));
vi.mock("../../lib/auth/passwords.js", () => ({
  hashPassword: vi.fn(async () => "argon2-hash"),
  verifyPassword: vi.fn()
}));
vi.mock("../../lib/auth/mfa.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/auth/mfa.js")>(),
  invalidateMfaChallenges: fake.invalidateMfa
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
const { authRouter } = await import("../auth.js");

type Handler = (req: Request, res: Response, next: (err?: unknown) => void) => unknown;

function handler(router: Router, path: string): Handler {
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  }).stack;
  const route = stack.find((layer) => layer.route?.path === path && layer.route.methods.post)?.route;
  expect(route, `POST ${path} must be mounted`).toBeDefined();
  return route!.stack[route!.stack.length - 1]!.handle;
}

async function call(router: Router, path: string, req: Partial<Request>) {
  const result = { status: 200, body: undefined as unknown };
  const res = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(payload: unknown) {
      result.body = payload;
      return res;
    },
    end() {
      return res;
    }
  } as unknown as Response;
  let failure: unknown;
  await handler(router, path)(req as Request, res, (err) => {
    failure = err;
  });
  if (failure) throw failure;
  return result as { status: number; body: Record<string, unknown> | undefined };
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

function adminReset(by: CurrentUser) {
  return call(usersRouter, "/:id/reset-password", { params: { id: TARGET_ID }, user: by } as Partial<Request>);
}

let ipCounter = 0;
function forgot(email: string) {
  ipCounter += 1;
  const ip = `198.51.100.${ipCounter}`;
  return call(authRouter, "/forgot-password", {
    body: { email },
    ip,
    protocol: "https",
    header: ((name: string) => (name === "x-forwarded-for" ? ip : undefined)) as Request["header"],
    get: (() => undefined) as unknown as Request["get"]
  });
}

/** A usable OIDC setup whose only SSO program is PROGRAM_ID. */
function configureOidc() {
  vi.stubEnv("OIDC_ISSUER_URL", "https://idp.example.com");
  vi.stubEnv("OIDC_CLIENT_ID", "test-client");
  vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-test-value");
  vi.stubEnv("OIDC_REDIRECT_URI", "https://app.example.com/api/auth/oidc/callback");
  vi.stubEnv("OIDC_STATE_SECRET", "synthetic-test-state-material-at-least-32-chars");
  vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", PROGRAM_ID);
}

beforeEach(() => {
  configureOidc();
  fake.target = { id: TARGET_ID, email: "agent@example.com", role: "csr", programId: PROGRAM_ID };
  fake.updates = [];
  fake.deletes = 0;
  fake.forgotRows = [];
  fake.send.mockReset().mockResolvedValue(undefined);
  fake.invalidateMfa.mockReset().mockResolvedValue(undefined);
  fake.createResetToken
    .mockReset()
    .mockResolvedValue({ token: "synthetic-reset-token", expiresAt: new Date("2026-10-11T00:00:00Z") });
  vi.stubEnv("APP_BASE_URL", "https://app.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/admin/users/:id/reset-password for SSO-only users", () => {
  it("returns a temp password when local login is enabled", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    const result = await adminReset(actor("manager"));
    expect(result.status).toBe(200);
    expect(typeof result.body?.tempPassword).toBe("string");
    expect(fake.updates).toHaveLength(1);
    expect(fake.deletes).toBe(1);
  });

  it.each([
    ["break_glass", "manager"],
    ["disabled", "manager"],
    ["break_glass", "supervisor"]
  ] as const)("refuses an SSO-only CSR under %s (actor %s) and changes nothing", async (mode, role) => {
    vi.stubEnv("LOCAL_LOGIN_MODE", mode);
    const result = await adminReset(actor(role));
    expect(result.status).toBe(409);
    expect(result.body?.tempPassword).toBeUndefined();
    expect(fake.updates).toHaveLength(0);
    expect(fake.deletes).toBe(0);
    expect(fake.invalidateMfa).not.toHaveBeenCalled();
  });

  it("still answers 404 for an out-of-scope SSO user", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    fake.target = { ...fake.target!, programId: "00000000-0000-4000-8000-0000000000b2" };
    const result = await adminReset(actor("manager"));
    expect(result.status).toBe(404);
  });

  it("still resets the break-glass super user", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    fake.target = { id: TARGET_ID, email: "emergency@example.com", role: "super_user", programId: null };
    const result = await adminReset(actor("super_user"));
    expect(result.status).toBe(200);
    expect(typeof result.body?.tempPassword).toBe("string");
  });
});

describe("POST /api/auth/forgot-password for SSO-only users", () => {
  const row = { id: TARGET_ID, email: "agent@example.com", name: "Agent", role: "csr", programId: PROGRAM_ID, isActive: true };

  it("emails a reset link when local login is enabled", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "enabled");
    fake.forgotRows = [row];
    const result = await forgot("agent1@example.com");
    expect(result.status).toBe(204);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(1));
    expect(fake.createResetToken).toHaveBeenCalledTimes(1);
    const email = fake.send.mock.calls[0]![0] as { text: string };
    expect(email.text).toContain("https://app.example.com/reset-password?token=synthetic-reset-token");
  });

  it.each(["break_glass", "disabled"])(
    "mints no token and emails an SSO sign-in notice under %s, with the same 204",
    async (mode) => {
      vi.stubEnv("LOCAL_LOGIN_MODE", mode);
      fake.forgotRows = [row];
      const result = await forgot(`agent-${mode}@example.com`);
      expect(result.status).toBe(204);
      await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(1));
      expect(fake.createResetToken).not.toHaveBeenCalled();
      const email = fake.send.mock.calls[0]![0] as { to: string; text: string; html: string };
      expect(email.to).toBe("agent@example.com");
      expect(email.text).toContain("https://app.example.com/login");
      expect(email.text).toContain("Continue with company SSO");
      expect(email.text).not.toContain("reset-password");
      expect(email.html).not.toContain("reset-password");
    }
  );

  it("tells a super user under disabled mode to ask an administrator, not to use SSO", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "disabled");
    fake.forgotRows = [{ ...row, email: "super@example.com", role: "super_user", programId: null }];
    const result = await forgot("super-disabled@example.com");
    expect(result.status).toBe(204);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(1));
    expect(fake.createResetToken).not.toHaveBeenCalled();
    const email = fake.send.mock.calls[0]![0] as { text: string; html: string };
    expect(email.text).toContain("Contact a Truenote administrator");
    expect(email.text).not.toContain("Continue with company SSO");
    expect(email.text).not.toContain("reset-password");
    expect(email.html).not.toContain("/login");
  });

  it("gives the administrator notice when OIDC is not usable", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    vi.stubEnv("OIDC_STATE_SECRET", "short");
    fake.forgotRows = [row];
    const result = await forgot("agent-no-oidc@example.com");
    expect(result.status).toBe(204);
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalledTimes(1));
    const email = fake.send.mock.calls[0]![0] as { text: string };
    expect(email.text).toContain("Contact a Truenote administrator");
    expect(email.text).not.toContain("Continue with company SSO");
  });

  it("sends nothing for an unknown email under break_glass", async () => {
    vi.stubEnv("LOCAL_LOGIN_MODE", "break_glass");
    fake.forgotRows = [];
    const result = await forgot("nobody@example.com");
    expect(result.status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.createResetToken).not.toHaveBeenCalled();
  });
});
