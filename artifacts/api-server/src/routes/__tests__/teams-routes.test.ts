import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response, Router } from "express";
import type { CurrentUser } from "../../lib/auth/current-user.js";
import { teamsWriteLimit } from "../../lib/security/route-rate-limit.js";
import {
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove
} from "../../middleware/current-user.js";
import { teamsRouter } from "../admin/teams.js";
import { canSupervisorResetPassword, usersRouter } from "../admin/users.js";

type Handler = (...args: unknown[]) => unknown;

interface RouterLayer {
  handle: Handler;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: Handler }>;
  };
}

function layers(router: Router): RouterLayer[] {
  return (router as unknown as { stack: RouterLayer[] }).stack;
}

function routeHandlers(router: Router, method: string, path: string): Handler[] {
  const layer = layers(router).find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method.toLowerCase()] === true
  );
  expect(layer, `${method} ${path} must be mounted`).toBeDefined();
  return layer?.route?.stack.map((entry) => entry.handle) ?? [];
}

/** Every route on the router as `METHOD path`. */
function routeKeys(router: Router): string[] {
  return layers(router).flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((method) => layer.route?.methods[method])
          .map((method) => `${method.toUpperCase()} ${layer.route?.path}`)
      : []
  );
}

/** Handlers mounted with `router.use(...)`: the layers without a route. */
function routerLevelHandlers(router: Router): Handler[] {
  return layers(router)
    .filter((layer) => !layer.route)
    .map((layer) => layer.handle);
}

function runGuard(
  guard: Handler,
  role: CurrentUser["role"]
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
    user: {
      id: "00000000-0000-4000-8000-000000000009",
      email: "guard@example.com",
      role,
      programId: "00000000-0000-4000-8000-00000000000a",
      name: "Guard",
      mustResetPassword: false
    }
  } as unknown as Request;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  guard(req, res, next);
  return { nextCalled, statusCode };
}

describe.each([
  ["teamsRouter", teamsRouter],
  ["usersRouter", usersRouter]
])("%s router-level guards", (_name, router) => {
  const known = new Set<Handler>([
    requireAuth as unknown as Handler,
    requireFreshPassword as unknown as Handler,
    blockDemoWrites as unknown as Handler
  ]);

  it("mounts requireAuth and requireFreshPassword on the whole router", () => {
    const handlers = routerLevelHandlers(router);
    expect(handlers).toContain(requireAuth);
    expect(handlers).toContain(requireFreshPassword);
  });

  it("mounts one role guard that refuses CSRs and admits supervisors", () => {
    const roleGuards = routerLevelHandlers(router).filter((handler) => !known.has(handler));
    expect(roleGuards).toHaveLength(1);
    const [roleGuard] = roleGuards as [Handler];

    const asCsr = runGuard(roleGuard, "csr");
    expect(asCsr.statusCode).toBe(403);
    expect(asCsr.nextCalled).toBe(false);

    const asSupervisor = runGuard(roleGuard, "supervisor");
    expect(asSupervisor.nextCalled).toBe(true);
    expect(asSupervisor.statusCode).toBeNull();
  });
});

describe("teams route guards", () => {
  it("runs the manager, demo and rate-limit guards before the PUT handler", () => {
    const handlers = routeHandlers(teamsRouter, "PUT", "/assignments");
    const handlerIndex = handlers.length - 1;
    for (const guard of [requireManagerOrAbove, blockDemoWrites, teamsWriteLimit]) {
      const index = handlers.indexOf(guard as unknown as Handler);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(handlerIndex);
    }
  });

  it("leaves GET / open to supervisors", () => {
    const handlers = routeHandlers(teamsRouter, "GET", "/");
    expect(handlers).not.toContain(requireManagerOrAbove);
  });
});

describe("users route guards", () => {
  const supervisorRoutes = new Set(["GET /", "POST /:id/reset-password"]);

  it("keeps every handler except list and reset-password manager-only", () => {
    const keys = routeKeys(usersRouter);
    expect(keys).toEqual(expect.arrayContaining([...supervisorRoutes]));
    expect(keys.length).toBeGreaterThan(supervisorRoutes.size);
    for (const key of keys) {
      const [method, path] = key.split(" ") as [string, string];
      const handlers = routeHandlers(usersRouter, method, path);
      if (supervisorRoutes.has(key)) {
        expect(handlers, key).not.toContain(requireManagerOrAbove);
      } else {
        const index = handlers.indexOf(requireManagerOrAbove as unknown as Handler);
        expect(index, key).toBeGreaterThanOrEqual(0);
        expect(index, key).toBeLessThan(handlers.length - 1);
      }
    }
  });
});

const PROGRAM_A = "00000000-0000-4000-8000-00000000000a";
const PROGRAM_B = "00000000-0000-4000-8000-00000000000b";

function actor(role: CurrentUser["role"], programId: string | null = PROGRAM_A): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "sup@example.com",
    role,
    programId,
    name: "Sup",
    mustResetPassword: false
  };
}

const csr = { id: "00000000-0000-4000-8000-000000000002", role: "csr" as const, programId: PROGRAM_A };

describe("canSupervisorResetPassword", () => {
  it("allows a supervisor to reset a CSR on their own team in their program", () => {
    expect(canSupervisorResetPassword(actor("supervisor"), csr, true)).toBe(true);
  });

  it("refuses a CSR who is not on the supervisor's team", () => {
    expect(canSupervisorResetPassword(actor("supervisor"), csr, false)).toBe(false);
  });

  it("refuses a target in another program, even with a team row", () => {
    expect(
      canSupervisorResetPassword(actor("supervisor"), { ...csr, programId: PROGRAM_B }, true)
    ).toBe(false);
    expect(canSupervisorResetPassword(actor("supervisor", null), csr, true)).toBe(false);
  });

  it("refuses non-CSR targets and the supervisor themselves", () => {
    for (const role of ["supervisor", "manager", "senior_manager", "super_user"] as const) {
      expect(canSupervisorResetPassword(actor("supervisor"), { ...csr, role }, true)).toBe(false);
    }
    const self = actor("supervisor");
    expect(
      canSupervisorResetPassword(self, { id: self.id, role: "csr", programId: PROGRAM_A }, true)
    ).toBe(false);
  });

  it("is false for every non-supervisor actor", () => {
    for (const role of ["csr", "manager", "senior_manager", "super_user"] as const) {
      expect(canSupervisorResetPassword(actor(role), csr, true)).toBe(false);
    }
  });
});
