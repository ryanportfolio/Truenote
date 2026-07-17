import { createApp } from "./app.js";
import { closePool } from "./lib/db-client.js";
import { bootstrapSuperUser } from "./lib/auth/bootstrap.js";
import { bootstrapDemoAccounts } from "./lib/auth/bootstrap-demo.js";
import { purgeExpiredSessions } from "./lib/auth/sessions.js";
import { purgeExpiredResetTokens } from "./lib/auth/password-reset.js";
import {
  installProcessErrorLogging,
  recordAppError,
  safeErrorMessage
} from "./lib/observability/error-log.js";
import { startSiemOutboxWorker } from "./lib/security/siem-outbox.js";

const PORT = Number(process.env.API_PORT) || 5000;
installProcessErrorLogging("api-server");

async function main(): Promise<void> {
  // Production guard: refuse to boot without APP_BASE_URL. The reset-
  // email path falls back to X-Forwarded-Host when this is unset,
  // which is attacker-controlled — a `POST /forgot-password` with a
  // spoofed header would otherwise deliver a reset link pointing at
  // the attacker's domain. The route handler also defends against
  // this, but failing at startup makes the misconfiguration obvious
  // in the deploy log instead of silent until someone tries to reset.
  if (process.env.NODE_ENV === "production" && !process.env.APP_BASE_URL) {
    console.error(
      "[api-server] APP_BASE_URL must be set when NODE_ENV=production. " +
        "This is the public origin used in password-reset emails; " +
        "falling back to request headers would let an attacker control " +
        "the URL embedded in a victim's reset email."
    );
    process.exit(1);
  }

  // Ensure a super_user exists for first login. Idempotent — runs every
  // boot but only writes when the table is empty of super_users. A failure
  // here is logged but does NOT prevent the server from starting; the
  // operator can recover by setting the bootstrap env vars and restarting.
  try {
    await bootstrapSuperUser();
  } catch (err) {
    console.error("[api-server] bootstrap failed:", safeErrorMessage(err));
    void recordAppError({
      source: "startup",
      operation: "bootstrap-super-user",
      error: err
    });
  }

  // Demo accounts for the pre-filled login (DEMO_LOGIN_ACCOUNTS). Same
  // failure posture as the super_user bootstrap: log and keep booting.
  try {
    await bootstrapDemoAccounts();
  } catch (err) {
    console.error(
      "[api-server] demo-account bootstrap failed:",
      safeErrorMessage(err)
    );
    void recordAppError({
      source: "startup",
      operation: "bootstrap-demo-accounts",
      error: err
    });
  }

  const app = createApp();
  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`[api-server] listening on http://0.0.0.0:${PORT}`);
  });
  const stopSiemOutboxWorker = startSiemOutboxWorker();

  // Hourly hygiene: drop expired session rows AND expired password-
  // reset tokens. Both tables grow unbounded otherwise (their queries
  // filter expired rows but the rows themselves stick around). The
  // interval is unref'd so it doesn't keep the process alive during
  // shutdown. Both sweeps are independent — a failure in one logs a
  // warning but doesn't block the other.
  const PURGE_INTERVAL_MS = 60 * 60 * 1000;
  const purgeTimer = setInterval(() => {
    purgeExpiredSessions()
      .then((n) => {
        if (n > 0) console.log(`[auth] purged ${n} expired sessions`);
      })
      .catch((err: unknown) => {
        console.warn(
          "[auth] purgeExpiredSessions failed:",
          safeErrorMessage(err)
        );
        void recordAppError({
          severity: "warning",
          source: "maintenance",
          operation: "purge-expired-sessions",
          error: err
        });
      });
    purgeExpiredResetTokens()
      .then((n) => {
        if (n > 0) console.log(`[auth] purged ${n} expired reset tokens`);
      })
      .catch((err: unknown) => {
        console.warn(
          "[auth] purgeExpiredResetTokens failed:",
          safeErrorMessage(err)
        );
        void recordAppError({
          severity: "warning",
          source: "maintenance",
          operation: "purge-expired-reset-tokens",
          error: err
        });
      });
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  const shutdown = (signal: string): void => {
    console.log(`[api-server] received ${signal}, draining…`);
    clearInterval(purgeTimer);
    stopSiemOutboxWorker();
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
  console.error("[api-server] fatal:", safeErrorMessage(err));
  void Promise.race([
    recordAppError({
      severity: "fatal",
      source: "startup",
      operation: "api-server-main",
      error: err
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000))
  ]).finally(() => process.exit(1));
});
