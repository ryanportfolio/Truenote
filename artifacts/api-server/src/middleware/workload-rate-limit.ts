import type { RequestHandler } from "express";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { recordSecurityEventBestEffort } from "../lib/security/audit.js";
import {
  enforceWorkloadRateLimit,
  type WorkloadRateLimitOperation
} from "../lib/security/distributed-rate-limit.js";

type WorkloadEnforcer = typeof enforceWorkloadRateLimit;

const MESSAGES: Record<WorkloadRateLimitOperation, string> = {
  document_ingestion:
    "Too many document-processing requests. Wait and try again.",
  evaluation_run: "Too many evaluation runs. Wait and try again.",
  bulk_user_import: "Too many bulk user imports. Wait and try again.",
  credential_administration:
    "Too many credential-administration requests. Wait and try again.",
  password_change: "Too many password-change requests. Wait and try again."
};

/**
 * Route-level distributed throttle for authenticated, high-amplification work.
 * Mount after requireAuth and before multipart parsing or expensive work.
 */
export function workloadRateLimitMiddleware(
  operation: WorkloadRateLimitOperation,
  enforce: WorkloadEnforcer = enforceWorkloadRateLimit
): RequestHandler {
  return async function workloadRateLimitRequest(
    req,
    res,
    next
  ): Promise<void> {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      const result = await enforce({ operation, userId: user.id });
      if (result.allowed) {
        next();
        return;
      }
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json({
        error: MESSAGES[operation],
        code: "workload_rate_limited"
      });
      recordSecurityEventBestEffort({
        action: "workload.rate_limited",
        outcome: "denied",
        actor: user,
        programId: user.programId,
        resourceType: "rate_limit",
        resourceId: operation,
        sourceIp: clientIpFrom(req),
        details: {
          scope: result.scope,
          operation,
          retryAfterSeconds: result.retryAfterSeconds
        }
      });
    } catch (error) {
      next(error);
    }
  };
}
