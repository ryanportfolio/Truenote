import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachCurrentUser } from "./middleware/current-user.js";
import { registerRoutes } from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
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
