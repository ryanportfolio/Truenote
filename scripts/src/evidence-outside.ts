/**
 * Outside-vantage watcher for the evidence harness, run daily by
 * .github/workflows/evidence-watch.yml from GitHub's network.
 *
 *   pnpm --filter @workspace/scripts run evidence:outside
 *
 * 1. Reads the public heartbeat (/api/evidence/heartbeat). Exits 1 when the
 *    last receipt is older than the stale limit or the endpoint is down: the
 *    harness cannot report its own silence.
 * 2. Repeats the passive public checks (TLS, redirects, headers, CSP,
 *    security.txt, DNS, /health) and prints the results. These are facts any
 *    visitor can see, so they are safe in a public log; they do not change
 *    the exit code. Production receipts come from the worker.
 *
 * Needs no credential and writes nothing.
 */
import {
  checkCsp,
  checkDnsCaa,
  checkHealth,
  checkRedirects,
  checkSecurityHeaders,
  checkSecurityTxt,
  checkTls,
  PUBLIC_ORIGIN
} from "../../artifacts/api-server/src/lib/evidence/checks/external.js";

const CHECKS = {
  "external.tls": checkTls,
  "external.http-redirect": checkRedirects,
  "external.security-headers": checkSecurityHeaders,
  "external.csp": checkCsp,
  "external.security-txt": checkSecurityTxt,
  "external.dns-caa": checkDnsCaa,
  "external.health": checkHealth
};

async function heartbeat(): Promise<boolean> {
  try {
    const response = await fetch(`${PUBLIC_ORIGIN}/api/evidence/heartbeat`, {
      signal: AbortSignal.timeout(15_000)
    });
    const body = (await response.json()) as { lastReceiptAt?: string | null; ageHours?: number | null; stale?: boolean };
    console.log(`heartbeat: HTTP ${response.status}, last receipt ${body.lastReceiptAt ?? "none"}, age ${body.ageHours ?? "?"} h`);
    return response.ok && body.stale === false;
  } catch (error) {
    console.log(`heartbeat: unreachable (${error instanceof Error ? error.message : error})`);
    return false;
  }
}

async function main(): Promise<void> {
  const fresh = await heartbeat();
  const lines: string[] = [];
  for (const [id, run] of Object.entries(CHECKS)) {
    try {
      const outcome = await run();
      lines.push(`${outcome.result.padEnd(5)} ${id}: ${outcome.summary}${outcome.failures?.length ? ` (${outcome.failures.join("; ")})` : ""}`);
    } catch (error) {
      lines.push(`error ${id}: ${error instanceof Error ? error.message : error}`);
    }
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [`### Evidence harness heartbeat: ${fresh ? "fresh" : "STALE"}`, "", "```", ...lines, "```", ""].join("\n")
    );
  }
  if (!fresh) {
    console.error("Evidence receipts are stale or the heartbeat is down.");
    process.exitCode = 1;
  }
}

await main();
