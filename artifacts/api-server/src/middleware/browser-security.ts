import type { NextFunction, Request, RequestHandler, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSP_NONCE_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

function normalizeHttpOrigin(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function firstForwardedValue(value: string | undefined): string | undefined {
  return value?.split(",")[0]?.trim() || undefined;
}

function requestOrigin(req: Request): string | null {
  const protocol =
    firstForwardedValue(req.get("x-forwarded-proto")) ?? req.protocol;
  const host =
    firstForwardedValue(req.get("x-forwarded-host")) ?? req.get("host");
  return host ? normalizeHttpOrigin(`${protocol}://${host}`) : null;
}

function trustedOrigins(req: Request, env: NodeJS.ProcessEnv): Set<string> {
  const origins = new Set<string>();
  const configured = [
    env.APP_BASE_URL,
    ...(env.CORS_ALLOWED_ORIGINS ?? "").split(","),
  ];
  for (const value of configured) {
    const origin = normalizeHttpOrigin(value);
    if (origin) origins.add(origin);
  }

  // Production must use explicit configuration. Replit's public host and its
  // internal API port differ, so trusting forwarded host data there would
  // weaken the configured boundary. Local/Vite development can safely derive
  // the public request origin to avoid requiring a fake deployment URL.
  if (env.NODE_ENV !== "production") {
    const current = requestOrigin(req);
    if (current) origins.add(current);
  }
  return origins;
}

function rejectOrigin(res: Response): void {
  res.status(403).json({
    error: "Request origin is not allowed.",
    code: "csrf_origin_rejected",
  });
}

/**
 * Browser CSRF defense for every mutating API request.
 *
 * Browsers send Origin on cross-origin mutations. Fetch Metadata catches
 * older or unusual browser requests that omit Origin. Requests with neither
 * header remain available to non-browser automation and operational probes;
 * they do not carry a victim browser's ambient cookie context.
 */
export function trustedMutationOriginMiddleware(
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    const rawOrigin = req.get("origin");
    if (rawOrigin !== undefined) {
      const origin = normalizeHttpOrigin(rawOrigin);
      if (!origin || !trustedOrigins(req, env).has(origin)) {
        rejectOrigin(res);
        return;
      }
      next();
      return;
    }

    const fetchSite = req.get("sec-fetch-site")?.trim().toLowerCase();
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      rejectOrigin(res);
      return;
    }
    next();
  };
}

/**
 * Enforced CSP for API and production SPA responses.
 *
 * Every served HTML script receives the per-response nonce. `strict-dynamic`
 * makes that nonce, rather than a same-origin host allowlist, the trust root.
 * React's dynamic style attributes require style-src-attr, while style
 * elements remain self-only.
 */
export function contentSecurityPolicy(
  scriptNonce: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  if (!CSP_NONCE_PATTERN.test(scriptNonce)) {
    throw new Error("CSP script nonce must be base64 or base64url encoded.");
  }
  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "img-src 'self' data: blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    `script-src 'nonce-${scriptNonce}' 'strict-dynamic' 'self'`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "style-src-elem 'self'",
    "require-trusted-types-for 'script'",
    "worker-src 'self' blob:",
  ];
  if (nodeEnv === "production") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Add one response nonce to every script tag in a trusted static HTML file. */
export function addScriptNonceToHtml(html: string, scriptNonce: string): string {
  if (!CSP_NONCE_PATTERN.test(scriptNonce)) {
    throw new Error("CSP script nonce must be base64 or base64url encoded.");
  }
  return html.replace(
    /<script\b(?![^>]*\bnonce\s*=)/gi,
    `<script nonce="${scriptNonce}"`,
  );
}

export function strictTransportSecurityPolicy(): string {
  return "max-age=63072000; includeSubDomains; preload";
}
