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

/**
 * Runs every automated check once, in catalog order, and appends one receipt
 * per check. A check that throws or times out is recorded as `error`: no
 * evidence that day, never a silent gap. The integrity checks and the
 * timestamp run last so they cover the receipts this run wrote.
 */

const CHECK_TIMEOUT_MS = 90_000;

interface RunContext {
  github: () => GithubClient;
}

type Runner = (ctx: RunContext) => Promise<CheckOutcome>;

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

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`check timed out after ${ms} ms`)), ms);
    })
  ]);
}

export function errorOutcome(error: unknown): CheckOutcome {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: "error",
    summary:
      error instanceof GithubConfigError
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
    outcome = await withTimeout(runner(ctx), CHECK_TIMEOUT_MS);
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
  const ctx: RunContext = {
    github: () => (client ??= githubClientFromEnv())
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
