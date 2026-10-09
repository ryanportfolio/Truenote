import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

// The super user's demo-limits switch lives in app_settings; each test sets
// the stored row (undefined = never saved).
const setting = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("../../lib/db-client.js", () => ({
  db: {
    execute: async () => ({
      rows: setting.value === undefined ? [] : [{ value: setting.value, updated_at: null, updated_by_name: null, updated_by_email: null }]
    })
  }
}));

import {
  blockDemoWrites,
  DEMO_WRITE_BLOCKED_MESSAGE
} from "../current-user.js";
import { forgetDemoLimits } from "../../lib/auth/demo-limits.js";

beforeEach(() => {
  setting.value = undefined;
  forgetDemoLimits();
});

const DEMO_ENV = JSON.stringify([
  {
    label: "Manager",
    email: "manager@demo.truenote",
    password: "pw",
    role: "manager"
  }
]);

const ORIGINAL = process.env.DEMO_LOGIN_ACCOUNTS;

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.DEMO_LOGIN_ACCOUNTS;
  } else {
    process.env.DEMO_LOGIN_ACCOUNTS = ORIGINAL;
  }
});

interface FakeResponse {
  statusCode: number | null;
  body: unknown;
  res: Response;
}

function fakeResponse(): FakeResponse {
  const state: FakeResponse = {
    statusCode: null,
    body: null,
    res: null as unknown as Response
  };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return state.res;
    },
    json(payload: unknown) {
      state.body = payload;
      return state.res;
    }
  } as unknown as Response;
  return state;
}

function fakeRequest(method: string, email: string | null): Request {
  return {
    method,
    user: email
      ? {
          id: "u1",
          email,
          role: "manager",
          programId: "p1",
          name: "Demo",
          mustResetPassword: false
        }
      : null
  } as unknown as Request;
}

async function run(method: string, email: string | null): Promise<{
  nextCalled: boolean;
  statusCode: number | null;
  body: unknown;
}> {
  const state = fakeResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  blockDemoWrites(fakeRequest(method, email), state.res, next);
  // The demo check reads the switch asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { nextCalled, statusCode: state.statusCode, body: state.body };
}

describe("blockDemoWrites", () => {
  it("403s a demo account on mutating methods with the standard notice", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const { nextCalled, statusCode, body } = await run(
        method,
        "manager@demo.truenote"
      );
      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(body).toMatchObject({ error: DEMO_WRITE_BLOCKED_MESSAGE });
    }
  });

  it("lets a demo account read", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled, statusCode } = await run("GET", "manager@demo.truenote");
    expect(nextCalled).toBe(true);
    expect(statusCode).toBeNull();
  });

  it("lets non-demo users mutate", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled } = await run("DELETE", "real.admin@company.com");
    expect(nextCalled).toBe(true);
  });

  it("is a no-op when demo mode is off", async () => {
    delete process.env.DEMO_LOGIN_ACCOUNTS;
    const { nextCalled } = await run("POST", "manager@demo.truenote");
    expect(nextCalled).toBe(true);
  });

  it("passes unauthenticated requests through to the auth guard", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled } = await run("POST", null);
    expect(nextCalled).toBe(true);
  });

  it("lets a demo account mutate once a super user lifts the limits", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    setting.value = { enabled: false };
    const { nextCalled, statusCode } = await run("POST", "manager@demo.truenote");
    expect(nextCalled).toBe(true);
    expect(statusCode).toBeNull();
  });

  it("keeps the limits on when the stored switch is malformed", async () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    setting.value = { enabled: "false" };
    const { statusCode } = await run("POST", "manager@demo.truenote");
    expect(statusCode).toBe(403);
  });
});
