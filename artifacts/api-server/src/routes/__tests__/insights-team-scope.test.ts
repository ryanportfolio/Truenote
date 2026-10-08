import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { NextFunction, Request, RequestHandler, Response, Router } from "express";
import type { UserRole } from "../../lib/auth/current-user.js";
import {
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import { insightsRouter, isUserInScope, suggestionsQuery } from "../admin/insights.js";

interface RouterLayer {
  handle: RequestHandler;
  route?: {
    path: string;
    stack: Array<{ handle: RequestHandler }>;
  };
}

const stack = (insightsRouter as unknown as Router & { stack: RouterLayer[] }).stack;
const routerLevel = stack.filter((layer) => layer.route === undefined);

function runGuard(
  guard: RequestHandler,
  role: UserRole | null
): { nextCalled: boolean; statusCode: number | null } {
  let statusCode: number | null = null;
  let nextCalled = false;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json() {
      return res;
    }
  } as unknown as Response;
  const req = {
    method: "GET",
    user: role
      ? {
          id: "00000000-0000-4000-8000-000000000001",
          email: "someone@example.com",
          role,
          programId: role === "super_user" ? null : "00000000-0000-4000-8000-0000000000aa",
          name: "Someone",
          mustResetPassword: false
        }
      : null
  } as unknown as Request;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  guard(req, res, next);
  return { nextCalled, statusCode };
}

describe("insights router guard", () => {
  it("runs requireAuth, requireFreshPassword, then one role guard before every route", () => {
    expect(routerLevel).toHaveLength(3);
    expect(stack.indexOf(routerLevel[2]!)).toBe(2);
    expect(routerLevel[0]!.handle).toBe(requireAuth);
    expect(routerLevel[1]!.handle).toBe(requireFreshPassword);
    expect(routerLevel[2]!.handle).not.toBe(requireManagerOrAbove);
  });

  it("lets supervisors and above through and refuses CSRs", () => {
    const guard = routerLevel[2]!.handle;
    for (const role of ["supervisor", "manager", "senior_manager", "super_user"] as const) {
      const result = runGuard(guard, role);
      expect(result, role).toEqual({ nextCalled: true, statusCode: null });
    }
    expect(runGuard(guard, "csr")).toEqual({ nextCalled: false, statusCode: 403 });
    expect(runGuard(guard, null)).toEqual({ nextCalled: false, statusCode: 401 });
  });

  it("does not re-add a manager-only guard on the scoped routes", () => {
    const paths = ["/kb-gaps", "/source-usage", "/source-usage/questions"];
    for (const path of paths) {
      const layer = stack.find((candidate) => candidate.route?.path === path);
      expect(layer, `${path} must be mounted`).toBeDefined();
      const handlers = layer?.route?.stack.map((entry) => entry.handle) ?? [];
      expect(handlers, path).not.toContain(requireManagerOrAbove);
    }
  });
});

describe("isUserInScope", () => {
  const SUPERVISOR = "0e7c4f8a-3b2d-4c1e-9f6a-5d8b7c6e4a21";
  const CSR = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";
  const OUTSIDER = "4f1f7a8e-2d1b-4c55-9a0e-6f2d9b8c1a11";

  it("admits anyone when there is no scope (manager and above)", () => {
    expect(isUserInScope(null, OUTSIDER)).toBe(true);
  });

  it("admits the supervisor and their CSRs only", () => {
    const scope = [SUPERVISOR, CSR];
    expect(isUserInScope(scope, SUPERVISOR)).toBe(true);
    expect(isUserInScope(scope, CSR)).toBe(true);
    expect(isUserInScope(scope, OUTSIDER)).toBe(false);
  });

  it("compares ids case-insensitively", () => {
    expect(isUserInScope([CSR], CSR.toUpperCase())).toBe(true);
    expect(isUserInScope([CSR.toUpperCase()], CSR)).toBe(true);
  });

  it("admits nobody for an empty scope", () => {
    expect(isUserInScope([], SUPERVISOR)).toBe(false);
  });
});

describe("suggestionsQuery team scope", () => {
  const dialect = new PgDialect();
  const PROGRAM = "00000000-0000-4000-8000-0000000000aa";
  const SUPERVISOR = "0e7c4f8a-3b2d-4c1e-9f6a-5d8b7c6e4a21";
  const CSR = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";

  function render(scope: string[] | null) {
    return dialect.sqlToQuery(
      suggestionsQuery({
        programId: PROGRAM,
        windowDays: 30,
        userId: CSR,
        scope,
        clearance: "public"
      })
    );
  }

  it("reads query_log once, through the q CTE, so every per-user CTE inherits its filter", () => {
    for (const scope of [null, [SUPERVISOR, CSR]]) {
      const { sql: text } = render(scope);
      expect(text.match(/from query_log\b/gi) ?? [], String(scope)).toHaveLength(1);
      expect(text).toMatch(/FROM query_log AS ql/);
    }
  });

  it("limits q to the team for a supervisor", () => {
    const { sql: text, params } = render([SUPERVISOR, CSR]);
    expect(text).toContain("ql.user_id::text = ANY(ARRAY[");
    expect(params).toContain(SUPERVISOR);
    expect(params).toContain(CSR);
  });

  it("leaves q program-wide for manager and above", () => {
    const { sql: text } = render(null);
    expect(text).not.toContain("= ANY(");
  });
});
