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

  // CORS — credentials:true is required so the browser sends the session
  // cookie on cross-origin XHR. In production the SPA and API share an
  // origin (api-server serves the built SPA), but Vite dev proxies /api
  // through to a different port, so we keep the permissive config.
  app.use(cors({ credentials: true }));
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
    app.use(express.static(dist));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(dist, "index.html"));
    });
  }

  // Centralized error handler. Keeps the shape consistent and prevents
  // leaking stack traces to the client.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[api-server] error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    res.status(500).json({ error: message });
  });

  return app;
}
