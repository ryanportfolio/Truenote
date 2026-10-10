import { randomUUID } from "node:crypto";
import { EVIDENCE_CHECKS, getCheck, type CheckDefinition } from "./catalog.js";
import {
  appendReceipt,
  buildReceiptPayload,
  type CheckOutcome,
  type CheckResult,
  type StoredReceipt
} from "./receipts.js";
import {
  checkBranchRuleset,
  checkCodeSecuritySettings,
  checkCredentialExpiry,
  checkOpenAlerts,
  checkSecurityWorkflow,
  GithubConfigError,
  githubClientFromEnv,
  type GithubClient
} from "./checks/github.js";
import {
  checkCsp,
  checkDnsCaa,
  checkHealth,
  checkRedirects,
  checkSecurityHeaders,
  checkSecurityTxt,
  checkTls
} from "./checks/external.js";
import {
  checkAppendOnlyRefusals,
  checkAuditTriggers,
  checkRuntimeRole
} from "./checks/database.js";
import {
  checkChainTimestamp,
  checkEvidenceChain,
  checkSecurityEventsChain
} from "./checks/integrity.js";
import {
  checkBadPasswordRefused,
  checkClassificationCeiling,
  checkDemoWriteBlock,
  checkProgramIsolation,
  checkSyntheticLoginWindows,
  parseSyntheticConfig,
  SyntheticConfigError,
  SYNTHETIC_HTTP_WORST_CASE_MS,
  syntheticDepsFromDb,
  type SyntheticConfig,
  type SyntheticDeps
} from "./checks/synthetic.js";

/**
 * Runs every automated check once, in catalog order, and appends one receipt
 * per check. A check that throws or times out is recorded as `error`: no
 * evidence that day, never a silent gap. On a timeout the check's signal is
 * aborted so it sends nothing more (the synthetic checks still log out). The
 * integrity checks and the timestamp run last so they cover the receipts
 * this run wrote.
 */

const CHECK_TIMEOUT_MS = 90_000;
/** Synthetic checks: their HTTP worst case plus a minute for the database reads. */
const SYNTHETIC_CHECK_TIMEOUT_MS = SYNTHETIC_HTTP_WORST_CASE_MS + 60_000;

function timeoutFor(check: CheckDefinition): number {
  return check.kind === "synthetic" ? SYNTHETIC_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS;
}

interface RunContext {
  github: () => GithubClient;
  /** Throws SyntheticConfigError when EVIDENCE_SYNTHETIC_ACCOUNTS is missing or bad. */
  synthetic: () => SyntheticConfig;
  syntheticDeps: () => SyntheticDeps;
}

/** `signal` aborts when the check's time limit passes. */
type Runner = (ctx: RunContext, signal: AbortSignal) => Promise<CheckOutcome>;

export const CHECK_RUNNERS: Record<string, Runner> = {
  "github.branch-ruleset": (ctx) => checkBranchRuleset(ctx.github()),
  "github.code-security-settings": (ctx) => checkCodeSecuritySettings(ctx.github()),
  "github.open-alerts": (ctx) => checkOpenAlerts(ctx.github()),
  "github.security-workflow": (ctx) => checkSecurityWorkflow(ctx.github()),
  "github.credential-expiry": (ctx) => checkCredentialExpiry(ctx.github()),
  "external.tls": () => checkTls(),
  "external.http-redirect": () => checkRedirects(),
  "external.security-headers": () => checkSecurityHeaders(),
  "external.csp": () => checkCsp(),
  "external.security-txt": () => checkSecurityTxt(),
  "external.dns-caa": () => checkDnsCaa(),
  "external.health": () => checkHealth(),
  "database.runtime-role": () => checkRuntimeRole(),
  "database.audit-triggers": () => checkAuditTriggers(),
  "database.append-only-refusals": () => checkAppendOnlyRefusals(),
  "synthetic.program-isolation": (ctx, signal) => checkProgramIsolation(ctx.synthetic(), ctx.syntheticDeps(), signal),
  "synthetic.classification-ceiling": (ctx, signal) =>
    checkClassificationCeiling(ctx.synthetic(), ctx.syntheticDeps(), signal),
  "synthetic.demo-write-block": (ctx, signal) => checkDemoWriteBlock(ctx.synthetic(), ctx.syntheticDeps(), signal),
  "synthetic.bad-password-refused": (ctx, signal) => checkBadPasswordRefused(ctx.synthetic(), ctx.syntheticDeps(), signal),
  // Reads only the database: runs even when EVIDENCE_SYNTHETIC_ACCOUNTS is missing or invalid.
  "synthetic.login-windows": (ctx) => checkSyntheticLoginWindows(null, ctx.syntheticDeps()),
  "integrity.evidence-chain": () => checkEvidenceChain(),
  "integrity.security-events-chain": () => checkSecurityEventsChain(),
  "integrity.chain-timestamp": () => checkChainTimestamp()
};

export interface RunEntry {
  checkId: string;
  result: CheckResult;
  summary: string;
  receipt: StoredReceipt;
}

/** Starts `start` with a signal that aborts after `ms`; rejects at that moment. */
function withTimeout<T>(start: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve()
      .then(() => start(controller.signal))
      .finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`check timed out after ${ms} ms`));
        reject(new Error(`check timed out after ${ms} ms`));
      }, ms);
    })
  ]);
}

export function errorOutcome(error: unknown): CheckOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: "error",
    summary:
      error instanceof GithubConfigError || error instanceof SyntheticConfigError
        ? `Not configured: ${message}`
        : "The check could not complete; no evidence for this run.",
    failures: [message.slice(0, 500)],
    outputs: {}
  };
}

export async function runOneCheck(
  check: CheckDefinition,
  runId: string,
  ctx: RunContext
): Promise<RunEntry> {
  const runner = CHECK_RUNNERS[check.id];
  const startedAt = new Date();
  let outcome: CheckOutcome;
  try {
    if (!runner) throw new Error(`no runner registered for ${check.id}`);
    outcome = await withTimeout((signal) => runner(ctx, signal), timeoutFor(check));
  } catch (error) {
    outcome = errorOutcome(error);
  }
  const receipt = await appendReceipt(
    buildReceiptPayload(check, outcome, { runId, startedAt, finishedAt: new Date() })
  );
  return { checkId: check.id, result: outcome.result, summary: outcome.summary, receipt };
}

/** Run the automated checks (all, or the listed ids) and return what was recorded. */
export async function runEvidenceChecks(onlyIds?: string[]): Promise<{ runId: string; entries: RunEntry[] }> {
  const runId = randomUUID();
  let client: GithubClient | undefined;
  // Parsed once per run; a bad config is remembered so each synthetic check
  // records the same "Not configured" error.
  let synthetic: { config: SyntheticConfig } | { error: unknown } | undefined;
  let syntheticDeps: SyntheticDeps | undefined;
  const ctx: RunContext = {
    github: () => (client ??= githubClientFromEnv()),
    synthetic: () => {
      if (!synthetic) {
        try {
          synthetic = {
            config: parseSyntheticConfig(
              process.env.EVIDENCE_SYNTHETIC_ACCOUNTS,
              process.env.EVIDENCE_SYNTHETIC_BASE_URL || undefined
            )
          };
        } catch (error) {
          synthetic = { error };
        }
      }
      if ("error" in synthetic) throw synthetic.error;
      return synthetic.config;
    },
    syntheticDeps: () => (syntheticDeps ??= syntheticDepsFromDb())
  };
  const checks = onlyIds
    ? onlyIds.map((id) => {
        const check = getCheck(id);
        if (!check) throw new Error(`unknown check ${id}`);
        return check;
      })
    : EVIDENCE_CHECKS.filter((check) => CHECK_RUNNERS[check.id]);
  const entries: RunEntry[] = [];
  for (const check of checks) {
    entries.push(await runOneCheck(check, runId, ctx));
  }
  return { runId, entries };
}
