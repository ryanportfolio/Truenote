import type { NextFunction, Request, RequestHandler, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// Git may materialize index.html with LF or CRLF depending on the build host.
// Both hashes represent the same static JSON-LD block with only line endings
// changed; allowing both keeps the production policy portable and exact.
const JSON_LD_SCRIPT_HASHES = [
  "'sha256-AjnjJ19PVMR54X+Ngxi+l6KID4BwmKiWNCakhZjrlb0='",
  "'sha256-mzwEHf+hexf5p9PXIB+clKkWnHKVaog3paHjZ9ztzug='",
].join(" ");

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
 * The only inline script is the static JSON-LD block in rag-app/index.html;
 * its exact hash is covered by a regression test. React's four dynamic style
 * attributes require style-src-attr, while style elements remain self-only.
 */
export function contentSecurityPolicy(nodeEnv = process.env.NODE_ENV): string {
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
    `script-src 'self' ${JSON_LD_SCRIPT_HASHES}`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "style-src-elem 'self'",
    "worker-src 'self' blob:",
  ];
  if (nodeEnv === "production") directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
