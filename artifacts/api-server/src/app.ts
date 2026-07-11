import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachCurrentUser } from "./middleware/current-user.js";
import { registerRoutes } from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

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
    cors({
      credentials: true,
      origin: corsAllowed.length > 0 ? corsAllowed : false
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(attachCurrentUser);

  registerRoutes(app);

  // 404 fallback for unknown API routes.
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });

  // In production the Vite dev server is not running, so the api-server
  // serves the pre-built frontend from rag-app/dist and handles SPA routing.
  if (process.env.NODE_ENV === "production") {
    const dist = path.resolve(__dirname, "../../rag-app/dist");
    // Cache policy by asset class. Without explicit headers express.static
    // sends ETag-only, so every logged-in navigation revalidates every
    // chunk against the server — one round-trip per asset, and Replit
    // round-trips are the expensive part of page loads here.
    //   /assets/*  — Vite content-hashed filenames; a change means a new
    //                URL, so cache forever.
    //   images     — stable brand files (public/), rarely swapped; a day.
    //   .html + everything else (perf-tier.js, manifest-ish files with
    //                stable names) — no-cache: always revalidate so a
    //                deploy propagates immediately.
    const assetsDir = `${path.sep}assets${path.sep}`;
    app.use(
      express.static(dist, {
        setHeaders: (res, filePath) => {
          if (filePath.includes(assetsDir)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else if (/\.(webp|png|jpe?g|svg|ico|woff2?)$/i.test(filePath)) {
            res.setHeader("Cache-Control", "public, max-age=86400");
          } else {
            res.setHeader("Cache-Control", "no-cache");
          }
        }
      })
    );
    app.get("*", (_req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Centralized error handler. In production the client message is a
  // generic string — Postgres error text (constraint names, column names,
  // sometimes connection strings via Drizzle pool errors) and any other
  // raw `err.message` value can leak schema or credential details. Full
  // detail still goes to the server log for operator diagnosis.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api-server] error:", err);
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
