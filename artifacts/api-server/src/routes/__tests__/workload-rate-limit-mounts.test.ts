import { describe, expect, it } from "vitest";
import type { Router } from "express";
import { evaluationsRouter } from "../admin/evaluations.js";
import { usersRouter } from "../admin/users.js";
import { authRouter } from "../auth.js";
import { documentsRouter } from "../documents.js";

interface RouterLayer {
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: { name?: string } }>;
  };
}

function handlerNames(router: Router, method: string, path: string): string[] {
  const stack = (router as unknown as { stack: RouterLayer[] }).stack;
  const layer = stack.find(
    (candidate) =>
      candidate.route?.path === path &&
      candidate.route.methods[method.toLowerCase()] === true
  );
  expect(layer, `${method} ${path} must be mounted`).toBeDefined();
  return layer?.route?.stack.map((entry) => entry.handle.name ?? "") ?? [];
}

describe("high-amplification route throttles", () => {
  it("runs document throttling before multipart parsing and ingestion handlers", () => {
    const upload = handlerNames(documentsRouter, "POST", "/upload");
    expect(upload[0]).toBe("workloadRateLimitRequest");
    expect(upload.indexOf("workloadRateLimitRequest")).toBeLessThan(
      upload.indexOf("multerMiddleware")
    );
    expect(handlerNames(documentsRouter, "POST", "/:versionId/rescan")[0]).toBe(
      "workloadRateLimitRequest"
    );
  });

  it("mounts limits on evaluation and credential-amplification routes", () => {
    expect(handlerNames(evaluationsRouter, "POST", "/runs")[0]).toBe(
      "workloadRateLimitRequest"
    );
    for (const path of ["/", "/bulk", "/:id/reset-password"]) {
      expect(handlerNames(usersRouter, "POST", path)[0]).toBe(
        "workloadRateLimitRequest"
      );
    }
    expect(
      handlerNames(authRouter, "POST", "/change-password")
    ).toContain("workloadRateLimitRequest");
  });
});
