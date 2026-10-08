import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { recordSecurityEventBestEffort } from "../lib/security/audit.js";

/**
 * Mount points for securityAuditMiddleware. app.ts passes this list to
 * app.use(), so Express decides membership with the same matcher it uses for
 * the routers below these paths: case-insensitive, absolute-form request
 * targets included. A string comparison on req.originalUrl missed both.
 */
export const AUDITED_ROUTE_BASES = [
  "/api/admin",
  "/api/documents",
  "/api/auth",
  "/api/kb/library"
];

/**
 * Path of the original request target, without the query string. An
 * absolute-form target (`http://user:pass@host/api/...`) keeps only its path:
 * the authority can carry credentials and must not reach the audit log.
 */
function requestPath(req: Request): string {
  const target = req.originalUrl.split("?")[0] ?? req.originalUrl;
  if (target.startsWith("/")) return target;
  const scheme = target.indexOf("://");
  const slash = scheme === -1 ? -1 : target.indexOf("/", scheme + 3);
  return slash === -1 ? "/" : target.slice(slash);
}

/**
 * Request path for the event's resourceId. The matched base is lowercased so
 * `/API/admin/users/x` and `/api/admin/users/x` log the same prefix; the rest
 * keeps the request's spelling. Must run before next(): Express rewrites
 * req.baseUrl and req.url as the request moves through routers.
 */
function auditedPath(req: Request, rawPath: string): string {
  const base = req.baseUrl.toLowerCase();
  // Express reports the exact base as req.path "/"; keep "/api/documents"
  // without a trailing slash when the request had none.
  const rest = req.path === "/" && !rawPath.endsWith("/") ? "" : req.path;
  return `${base}${rest}`;
}

/**
 * Coverage net for every security-sensitive mutation. Domain routes add richer
 * events for approval/revocation; this event guarantees a newly added admin
 * endpoint is still visible without logging request bodies or credentials.
 * Mount with app.use(AUDITED_ROUTE_BASES, securityAuditMiddleware).
 */
export function securityAuditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const incoming = req.header("x-request-id")?.trim();
  const requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
  res.setHeader("X-Request-Id", requestId);
  const startedAt = Date.now();
  const rawPath = requestPath(req);
  const path = auditedPath(req, rawPath);
  res.once("finish", () => {
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
        durationMs: Date.now() - startedAt,
        ...(rawPath === path ? {} : { rawPath })
      }
    });
  });
  next();
}
