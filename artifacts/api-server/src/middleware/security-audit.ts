import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { recordSecurityEventBestEffort } from "../lib/security/audit.js";

const AUDITED_BASES = ["/api/admin", "/api/documents", "/api/auth"];

function shouldAudit(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return false;
  const path = req.originalUrl.split("?")[0] ?? req.originalUrl;
  return AUDITED_BASES.some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * Coverage net for every security-sensitive mutation. Domain routes add richer
 * events for approval/revocation; this event guarantees a newly added admin
 * endpoint is still visible without logging request bodies or credentials.
 */
export function securityAuditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!shouldAudit(req)) {
    next();
    return;
  }
  const incoming = req.header("x-request-id")?.trim();
  const requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const startedAt = Date.now();
  res.once("finish", () => {
    const path = req.originalUrl.split("?")[0] ?? req.originalUrl;
    recordSecurityEventBestEffort({
      action: "http.security_mutation",
      outcome: res.statusCode < 400 ? "success" : res.statusCode < 500 ? "denied" : "failure",
      actor: req.user,
      programId: req.user?.programId ?? null,
      resourceType: "http_route",
      resourceId: `${req.method} ${path}`,
      requestId,
      sourceIp: clientIpFrom(req),
      details: {
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      }
    });
  });
  next();
}
