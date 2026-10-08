import { describe, expect, it } from "vitest";
import type { Router } from "express";
import {
  teamsReadLimit,
  userAdminWriteLimit
} from "../../lib/security/route-rate-limit.js";
import { requireManagerOrAbove } from "../../middleware/current-user.js";
import { teamsRouter } from "../admin/teams.js";
import { usersRouter } from "../admin/users.js";

type Handler = (...args: unknown[]) => unknown;

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: Handler }>;
  };
}

function routeHandlers(router: Router, method: string, path: string): Handler[] {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  const layer = stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method.toLowerCase()] === true
  );
  expect(layer, `${method} ${path} must be mounted`).toBeDefined();
  return layer?.route?.stack.map((entry) => entry.handle) ?? [];
}

describe("per-user rate limits on team and user admin routes", () => {
  it("limits GET /api/admin/teams before the handler", () => {
    const handlers = routeHandlers(teamsRouter, "GET", "/");
    const index = handlers.indexOf(teamsReadLimit as unknown as Handler);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(handlers.length - 1);
  });

  it.each([
    ["POST", "/"],
    ["POST", "/bulk"],
    ["PATCH", "/:id"],
    ["DELETE", "/:id"]
  ])("limits %s /api/admin/users%s before requireManagerOrAbove", (method, path) => {
    const handlers = routeHandlers(usersRouter, method, path);
    const limitIndex = handlers.indexOf(userAdminWriteLimit as unknown as Handler);
    const guardIndex = handlers.indexOf(requireManagerOrAbove as unknown as Handler);
    expect(limitIndex).toBeGreaterThanOrEqual(0);
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(limitIndex).toBeLessThan(guardIndex);
  });

  it("keeps the workload throttle first on POST / and /bulk", () => {
    for (const path of ["/", "/bulk"]) {
      const handlers = routeHandlers(usersRouter, "POST", path);
      expect(handlers[0]?.name, path).toBe("workloadRateLimitRequest");
      expect(handlers[1], path).toBe(userAdminWriteLimit);
    }
  });
});
