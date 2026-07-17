import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { attachCurrentUser } from "./middleware/current-user.js";
import { registerRoutes } from "./routes/index.js";
import {
  recordAppError,
  safeErrorMessage
} from "./lib/observability/error-log.js";
import { robotsHeaderForSpaPath } from "./lib/seo.js";
import { securityAuditMiddleware } from "./middleware/security-audit.js";
import { SecurityControlsNotReadyError } from "./lib/security/errors.js";
import { compressedAssetFileName } from "./lib/security/static-assets.js";
import {
  contentSecurityPolicy,
  trustedMutationOriginMiddleware,
} from "./middleware/browser-security.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  const dist = path.resolve(__dirname, "../../rag-app/dist");

  app.disable("x-powered-by");
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy());
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  });

  // Serve the built SPA before API middleware. Authenticated browsers send
  // the session cookie on every same-origin request; if static files flow
  // through attachCurrentUser, each HTML/JS/CSS request waits on a database
  // session lookup before Express can read the file. Vite fingerprints files
  // under /assets, so they are safe to cache forever. Unhashed public files
  // keep Express's revalidation behavior.
  if (process.env.NODE_ENV === "production") {
    const assetsDir = path.join(dist, "assets");
    app.get("/assets/*", (req: Request, res: Response, next: NextFunction) => {
      const accepted = req.headers["accept-encoding"] ?? "";
      const suffix = accepted.includes("br")
        ? ".br"
        : accepted.includes("gzip")
          ? ".gz"
          : null;
      if (!suffix) return next();

      const relativePath = req.params[0];
      if (typeof relativePath !== "string") return next();
      const compressedFileName = compressedAssetFileName(relativePath, suffix);
      if (
        compressedFileName === null ||
        !existsSync(path.join(assetsDir, compressedFileName))
      ) {
        return next();
      }

      // res.type() treats any string containing "/" as a literal MIME type.
      // Passing the absolute path therefore emitted an invalid Content-Type
      // like "/home/runner/.../index.js", which browsers refuse for modules.
      res.type(path.extname(relativePath));
      res.setHeader("Content-Encoding", suffix === ".br" ? "br" : "gzip");
      res.vary("Accept-Encoding");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(compressedFileName, { root: assetsDir });
    });
    app.use(
      "/assets",
      express.static(assetsDir, {
        immutable: true,
        maxAge: "1y"
      })
    );
    // Resolve real directory indexes such as /about/ before the SPA fallback.
    // Unknown paths still fall through because only physical index.html files
    // are served here.
    app.use(express.static(dist, { index: "index.html", maxAge: 0 }));
  }

  // CORS — explicit allowlist. Two facts shape this:
  //   1. credentials:true REQUIRES a specific Access-Control-Allow-Origin
  //      value; the wildcard "*" the cors package emits by default is
  //      rejected by the browser for credentialed requests, so cookies
  //      silently fail to flow on actual cross-origin XHR.
  //   2. The deployed topology IS same-origin (api-server serves the
  //      built SPA in prod; Vite proxy in dev). CORS doesn't trigger at
  //      all — so a permissive config is harmless today but a footgun
  //      the moment topology changes (separate CDN, mobile app, etc.).
  // The fix is to bound the allowlist via env. Unset → empty list →
  // no cross-origin requests permitted. Set CORS_ALLOWED_ORIGINS to a
  // comma-separated list of origins to allow (e.g., dev tooling).
  const corsAllowed = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    "/api",
    cors({
      credentials: true,
      origin: corsAllowed.length > 0 ? corsAllowed : false
    })
  );
  app.use("/api", (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api", cookieParser());
  app.use("/api", attachCurrentUser);
  app.use("/api", securityAuditMiddleware);
  app.use("/api", trustedMutationOriginMiddleware());
  app.use("/api", express.json({ limit: "1mb" }));

  registerRoutes(app);

  // 404 fallback for unknown API routes.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // In production the Vite dev server is not running, so the api-server
  // serves the pre-built frontend from rag-app/dist and handles SPA routing.
  if (process.env.NODE_ENV === "production") {
    app.get("*", (req: Request, res: Response) => {
      // HTML must revalidate so a new deploy can point at its new hashed
      // assets immediately. The assets themselves remain immutable above.
      res.setHeader("Cache-Control", "no-cache");
      const robotsHeader = robotsHeaderForSpaPath(req.path);
      if (robotsHeader) res.setHeader("X-Robots-Tag", robotsHeader);
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Centralized error handler. In production the client message is a
  // generic string — Postgres error text (constraint names, column names,
  // sometimes connection strings via Drizzle pool errors) and any other
  // raw `err.message` value can leak schema or credential details. Full
  // detail still goes to the server log for operator diagnosis.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error("[api-server] error:", safeErrorMessage(err));
    const incomingRequestId = req.headers["x-request-id"];
    void recordAppError({
      source: "api",
      operation: "unhandled-request",
      error: err,
      correlationId:
        typeof incomingRequestId === "string" ? incomingRequestId : null,
      method: req.method,
      path: req.path,
      userId: req.user?.id,
      programId: req.user?.programId,
      context: {
        contentType: req.headers["content-type"] ?? null,
        responseHeadersSent: res.headersSent
      }
    });
    if (err instanceof SecurityControlsNotReadyError) {
      res.status(503).json({ error: err.message, code: "security_controls_not_ready" });
      return;
    }
    const message =
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err instanceof Error
          ? err.message
          : "Internal server error";
    res.status(500).json({ error: message });
  });

  return app;
}
