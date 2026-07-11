import { afterEach, describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  blockDemoWrites,
  DEMO_WRITE_BLOCKED_MESSAGE
} from "../current-user.js";

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

function run(method: string, email: string | null): {
  nextCalled: boolean;
  statusCode: number | null;
  body: unknown;
} {
  const state = fakeResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  blockDemoWrites(fakeRequest(method, email), state.res, next);
  return { nextCalled, statusCode: state.statusCode, body: state.body };
}

describe("blockDemoWrites", () => {
  it("403s a demo account on mutating methods with the standard notice", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      const { nextCalled, statusCode, body } = run(
        method,
        "manager@demo.truenote"
      );
      expect(nextCalled).toBe(false);
      expect(statusCode).toBe(403);
      expect(body).toMatchObject({ error: DEMO_WRITE_BLOCKED_MESSAGE });
    }
  });

  it("lets a demo account read", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled, statusCode } = run("GET", "manager@demo.truenote");
    expect(nextCalled).toBe(true);
    expect(statusCode).toBeNull();
  });

  it("lets non-demo users mutate", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled } = run("DELETE", "real.admin@company.com");
    expect(nextCalled).toBe(true);
  });

  it("is a no-op when demo mode is off", () => {
    delete process.env.DEMO_LOGIN_ACCOUNTS;
    const { nextCalled } = run("POST", "manager@demo.truenote");
    expect(nextCalled).toBe(true);
  });

  it("passes unauthenticated requests through to the auth guard", () => {
    process.env.DEMO_LOGIN_ACCOUNTS = DEMO_ENV;
    const { nextCalled } = run("POST", null);
    expect(nextCalled).toBe(true);
  });
});
