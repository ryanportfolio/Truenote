import { createApp } from "./app.js";
import { closePool } from "./lib/db-client.js";
import { bootstrapSuperUser } from "./lib/auth/bootstrap.js";

const PORT = Number(process.env.API_PORT) || 5000;

async function main(): Promise<void> {
  // Ensure a super_user exists for first login. Idempotent — runs every
  // boot but only writes when the table is empty of super_users. A failure
  // here is logged but does NOT prevent the server from starting; the
  // operator can recover by setting the bootstrap env vars and restarting.
  try {
    await bootstrapSuperUser();
  } catch (err) {
    console.error("[api-server] bootstrap failed:", err);
  }

  const app = createApp();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[api-server] listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = (signal: string): void => {
    console.log(`[api-server] received ${signal}, draining…`);
    server.close(() => {
      closePool().finally(() => process.exit(0));
    });
    // Force-exit after 10s if the server hasn't closed gracefully.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[api-server] fatal:", err);
  process.exit(1);
});
