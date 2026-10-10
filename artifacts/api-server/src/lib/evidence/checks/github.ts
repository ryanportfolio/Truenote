import type { CheckOutcome } from "../receipts.js";

/**
 * GitHub posture checks. Read-only REST calls with a fine-grained token
 * (EVIDENCE_GITHUB_TOKEN) scoped to the repository: Administration, Actions,
 * Code scanning alerts, Dependabot alerts, Secret scanning alerts and
 * Metadata, all read. The worker runs them so alert details stay out of the
 * public repository's Action logs.
 *
 * Collection (fetch) and evaluation (pure functions below) are separate so
 * the pass conditions are unit-tested without the network.
 */

export const REQUIRED_STATUS_CHECKS = [
  "Typecheck, build, tests",
  "Secret scan",
  "CodeQL analysis and SARIF evidence",
  "Dependency audit and SBOM"
] as const;

/** Proposed SI-2/RA-5 remediation window for critical and high findings. */
export const ALERT_REMEDIATION_DAYS = 30;
const TOKEN_MIN_DAYS = 30;
const SCHEDULED_RUN_MAX_AGE_DAYS = 8;
const DAY_MS = 86_400_000;
const MAX_PAGES = 20;

export interface GithubResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export interface GithubClient {
  repo: string;
  get(pathAndQuery: string): Promise<GithubResponse>;
  getAll(pathAndQuery: string): Promise<unknown[]>;
}

export class GithubConfigError extends Error {}

export function githubClientFromEnv(env: NodeJS.ProcessEnv = process.env): GithubClient {
  const token = env.EVIDENCE_GITHUB_TOKEN;
  if (!token) throw new GithubConfigError("EVIDENCE_GITHUB_TOKEN is not set");
  const repo = env.EVIDENCE_GITHUB_REPO ?? "ryanportfolio/Truenote";
  const base = "https://api.github.com";

  async function request(url: string): Promise<GithubResponse> {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "truenote-evidence-harness"
      },
      signal: AbortSignal.timeout(20_000)
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text.slice(0, 500);
      }
    }
    return { status: response.status, headers: response.headers, body };
  }

  return {
    repo,
    get: (pathAndQuery) => request(`${base}${pathAndQuery.replace("{repo}", repo)}`),
    async getAll(pathAndQuery) {
      const items: unknown[] = [];
      let url: string | null = `${base}${pathAndQuery.replace("{repo}", repo)}`;
      for (let page = 0; url && page < MAX_PAGES; page += 1) {
        const response = await request(url);
        if (response.status !== 200 || !Array.isArray(response.body)) {
          throw new Error(`GET ${pathAndQuery} answered ${response.status}`);
        }
        items.push(...response.body);
        const link = response.headers.get("link") ?? "";
        url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      }
      // Partial lists could hide an overdue alert on a later page.
      if (url) throw new Error(`GET ${pathAndQuery} has more than ${MAX_PAGES} pages; collection incomplete`);
      return items;
    }
  };
}

function requireOk(response: GithubResponse, what: string): Record<string, unknown> {
  if (response.status !== 200 || typeof response.body !== "object" || response.body === null) {
    throw new Error(`${what} answered ${response.status}`);
  }
  return response.body as Record<string, unknown>;
}

// ---------------------------------------------------------------- rulesets

export interface RulesetRule {
  type: string;
  ruleset_id?: number;
  parameters?: Record<string, unknown> | null;
}

export interface RulesetDetail {
  id: number;
  name: string;
  enforcement: string;
  bypass_actors?: Array<{ actor_id: number | null; actor_type: string; bypass_mode: string }>;
}

export function evaluateBranchRuleset(
  rules: RulesetRule[],
  rulesets: RulesetDetail[]
): CheckOutcome {
  const failures: string[] = [];
  const types = new Set(rules.map((rule) => rule.type));
  for (const required of ["deletion", "non_fast_forward", "pull_request", "required_status_checks"]) {
    if (!types.has(required)) failures.push(`default branch has no active '${required}' rule`);
  }
  const contexts = rules
    .filter((rule) => rule.type === "required_status_checks")
    .flatMap((rule) => {
      const checks = (rule.parameters?.required_status_checks ?? []) as Array<{ context?: string }>;
      return checks.map((check) => check.context ?? "");
    });
  for (const context of REQUIRED_STATUS_CHECKS) {
    if (!contexts.includes(context)) failures.push(`required status check missing: ${context}`);
  }
  const bypass = rulesets.flatMap((ruleset) =>
    (ruleset.bypass_actors ?? []).map((actor) => ({ ruleset: ruleset.name, ...actor }))
  );
  for (const actor of bypass) {
    if (actor.bypass_mode === "always") {
      failures.push(`ruleset '${actor.ruleset}' lets ${actor.actor_type} ${actor.actor_id ?? ""} bypass always`.trim());
    }
  }
  const pullRequest = rules.find((rule) => rule.type === "pull_request");
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? "Default branch requires a pull request, the required checks, and blocks force-push and deletion."
        : `${failures.length} ruleset requirement(s) not met.`,
    failures,
    outputs: {
      rulesets: rulesets.map((ruleset) => ({
        id: ruleset.id,
        name: ruleset.name,
        enforcement: ruleset.enforcement
      })),
      ruleTypes: [...types].sort(),
      requiredStatusChecks: contexts.sort(),
      requiredApprovingReviewCount:
        (pullRequest?.parameters?.required_approving_review_count as number | undefined) ?? null,
      bypassActors: bypass
    }
  };
}

export async function checkBranchRuleset(client: GithubClient): Promise<CheckOutcome> {
  const repo = requireOk(await client.get("/repos/{repo}"), "GET /repos");
  const branch = String(repo.default_branch ?? "main");
  const rulesResponse = await client.get(`/repos/{repo}/rules/branches/${encodeURIComponent(branch)}`);
  if (rulesResponse.status !== 200 || !Array.isArray(rulesResponse.body)) {
    throw new Error(`GET rules/branches answered ${rulesResponse.status}`);
  }
  const rules = rulesResponse.body as RulesetRule[];
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id).filter((id): id is number => typeof id === "number"))];
  const rulesets: RulesetDetail[] = [];
  for (const id of ids) {
    rulesets.push(requireOk(await client.get(`/repos/{repo}/rulesets/${id}`), `GET rulesets/${id}`) as unknown as RulesetDetail);
  }
  const outcome = evaluateBranchRuleset(rules, rulesets);
  return { ...outcome, inputs: { repo: client.repo, branch } };
}

// ------------------------------------------------------ security settings

export function evaluateCodeSecuritySettings(
  securityAndAnalysis: Record<string, { status?: string } | undefined> | null,
  vulnerabilityAlertsStatus: number
): CheckOutcome {
  const failures: string[] = [];
  const status = (key: string) => securityAndAnalysis?.[key]?.status ?? "unknown";
  if (status("secret_scanning") !== "enabled") failures.push("secret scanning is not enabled");
  if (status("secret_scanning_push_protection") !== "enabled") failures.push("push protection is not enabled");
  if (vulnerabilityAlertsStatus !== 204) failures.push("Dependabot alerts are not enabled");
  const settings = Object.fromEntries(
    Object.keys(securityAndAnalysis ?? {}).sort().map((key) => [key, status(key)])
  );
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? "Secret scanning, push protection and Dependabot alerts are enabled."
        : `${failures.length} security setting(s) off.`,
    failures,
    outputs: { securityAndAnalysis: settings, dependabotAlertsEnabled: vulnerabilityAlertsStatus === 204 }
  };
}

export async function checkCodeSecuritySettings(client: GithubClient): Promise<CheckOutcome> {
  const repo = requireOk(await client.get("/repos/{repo}"), "GET /repos");
  const alerts = await client.get("/repos/{repo}/vulnerability-alerts");
  if (alerts.status !== 204 && alerts.status !== 404) {
    throw new Error(`GET vulnerability-alerts answered ${alerts.status}`);
  }
  const outcome = evaluateCodeSecuritySettings(
    (repo.security_and_analysis ?? null) as Record<string, { status?: string }> | null,
    alerts.status
  );
  return { ...outcome, inputs: { repo: client.repo } };
}

// ------------------------------------------------------------ open alerts

export interface AlertSummaryInput {
  dependabot: Array<{ severity: string; createdAt: string }>;
  codeScanning: Array<{ severity: string; createdAt: string }>;
  secretScanningOpen: number;
}

function bucket(alerts: Array<{ severity: string; createdAt: string }>, now: Date) {
  const bySeverity: Record<string, number> = {};
  const overdue: Record<string, number> = {};
  let oldestCriticalHighDays: number | null = null;
  for (const alert of alerts) {
    const severity = alert.severity.toLowerCase();
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;
    if (severity === "critical" || severity === "high") {
      const ageDays = Math.floor((now.getTime() - Date.parse(alert.createdAt)) / DAY_MS);
      oldestCriticalHighDays = Math.max(oldestCriticalHighDays ?? 0, ageDays);
      if (ageDays > ALERT_REMEDIATION_DAYS) overdue[severity] = (overdue[severity] ?? 0) + 1;
    }
  }
  return { bySeverity, overdue, oldestCriticalHighDays };
}

export function evaluateOpenAlerts(input: AlertSummaryInput, now = new Date()): CheckOutcome {
  const dependabot = bucket(input.dependabot, now);
  const codeScanning = bucket(input.codeScanning, now);
  const failures: string[] = [];
  const overdueCount = (overdue: Record<string, number>) =>
    Object.values(overdue).reduce((sum, n) => sum + n, 0);
  if (overdueCount(dependabot.overdue) > 0) {
    failures.push(`${overdueCount(dependabot.overdue)} critical/high Dependabot alert(s) open over ${ALERT_REMEDIATION_DAYS} days`);
  }
  if (overdueCount(codeScanning.overdue) > 0) {
    failures.push(`${overdueCount(codeScanning.overdue)} critical/high code-scanning alert(s) open over ${ALERT_REMEDIATION_DAYS} days`);
  }
  if (input.secretScanningOpen > 0) {
    failures.push(`${input.secretScanningOpen} open secret-scanning alert(s)`);
  }
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? `No overdue critical or high alerts and no open secret-scanning alerts (window ${ALERT_REMEDIATION_DAYS} days).`
        : `${failures.length} alert condition(s) not met.`,
    failures,
    inputs: { remediationDays: ALERT_REMEDIATION_DAYS },
    outputs: { dependabot, codeScanning, secretScanningOpen: input.secretScanningOpen }
  };
}

export async function checkOpenAlerts(client: GithubClient): Promise<CheckOutcome> {
  const [dependabot, codeScanning, secrets] = await Promise.all([
    client.getAll("/repos/{repo}/dependabot/alerts?state=open&per_page=100"),
    client.getAll("/repos/{repo}/code-scanning/alerts?state=open&per_page=100"),
    client.getAll("/repos/{repo}/secret-scanning/alerts?state=open&per_page=100")
  ]);
  const outcome = evaluateOpenAlerts({
    dependabot: dependabot.map((alert) => {
      const a = alert as { created_at: string; security_advisory?: { severity?: string } };
      return { severity: a.security_advisory?.severity ?? "unknown", createdAt: a.created_at };
    }),
    codeScanning: codeScanning.map((alert) => {
      const a = alert as {
        created_at: string;
        rule?: { security_severity_level?: string | null; severity?: string | null };
      };
      return {
        severity: a.rule?.security_severity_level ?? a.rule?.severity ?? "unknown",
        createdAt: a.created_at
      };
    }),
    secretScanningOpen: secrets.length
  });
  return { ...outcome, inputs: { ...outcome.inputs, repo: client.repo } };
}

// ------------------------------------------------------ security workflow

export interface WorkflowRunSummary {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  headSha: string;
  url: string;
}

export function evaluateSecurityWorkflow(
  scheduled: WorkflowRunSummary | null,
  push: WorkflowRunSummary | null,
  now = new Date()
): CheckOutcome {
  const failures: string[] = [];
  if (!scheduled) {
    failures.push("no scheduled run on the default branch");
  } else {
    const ageDays = (now.getTime() - Date.parse(scheduled.createdAt)) / DAY_MS;
    if (scheduled.conclusion !== "success") {
      failures.push(`latest scheduled run concluded ${scheduled.conclusion ?? scheduled.status}`);
    }
    if (ageDays > SCHEDULED_RUN_MAX_AGE_DAYS) {
      failures.push(`latest scheduled run is ${Math.floor(ageDays)} days old`);
    }
  }
  if (!push) {
    failures.push("no push run on the default branch");
  } else if (push.conclusion !== "success") {
    failures.push(`latest push run concluded ${push.conclusion ?? push.status}`);
  }
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? "Latest scheduled and push runs of the security workflow passed."
        : `${failures.length} workflow condition(s) not met.`,
    failures,
    outputs: { scheduled, push }
  };
}

/**
 * The newest run that reached a verdict. A run still in progress has none
 * yet, and a run the workflow's concurrency group cancelled was superseded by
 * a newer one on the same ref; neither says whether the workflow passes.
 */
export function pickDecisiveRun(runs: Array<Record<string, unknown>>): Record<string, unknown> | null {
  return runs.find((run) => run.status === "completed" && run.conclusion !== "cancelled") ?? null;
}

async function latestRun(client: GithubClient, branch: string, event: string): Promise<WorkflowRunSummary | null> {
  const body = requireOk(
    await client.get(
      `/repos/{repo}/actions/workflows/security.yml/runs?branch=${encodeURIComponent(branch)}&event=${event}&per_page=20`
    ),
    `GET security.yml runs (${event})`
  );
  const run = pickDecisiveRun((body.workflow_runs as Array<Record<string, unknown>> | undefined) ?? []);
  if (!run) return null;
  return {
    id: Number(run.id),
    event: String(run.event),
    status: String(run.status),
    conclusion: (run.conclusion as string | null) ?? null,
    createdAt: String(run.created_at),
    headSha: String(run.head_sha),
    url: String(run.html_url)
  };
}

export async function checkSecurityWorkflow(client: GithubClient): Promise<CheckOutcome> {
  const repo = requireOk(await client.get("/repos/{repo}"), "GET /repos");
  const branch = String(repo.default_branch ?? "main");
  const [scheduled, push] = await Promise.all([
    latestRun(client, branch, "schedule"),
    latestRun(client, branch, "push")
  ]);
  const outcome = evaluateSecurityWorkflow(scheduled, push);
  return { ...outcome, inputs: { repo: client.repo, workflow: ".github/workflows/security.yml", branch } };
}

// ----------------------------------------------------- credential expiry

/** Parses GitHub's "2026-11-10 06:00:00 UTC" / "2026-11-10 06:00:00 -0700". */
export function parseTokenExpiration(header: string | null): Date | null {
  if (!header) return null;
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(header.trim());
  if (!match) return null;
  const [, day, time, zone] = match;
  const offset = zone === "UTC" ? "Z" : `${zone!.slice(0, 3)}:${zone!.slice(3)}`;
  const parsed = new Date(`${day}T${time}${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function evaluateCredentialExpiry(
  status: number,
  expirationHeader: string | null,
  now = new Date()
): CheckOutcome {
  const failures: string[] = [];
  const expiresAt = parseTokenExpiration(expirationHeader);
  const daysLeft = expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / DAY_MS) : null;
  if (status !== 200) failures.push(`token request answered ${status}`);
  if (expirationHeader && !expiresAt) failures.push(`unreadable expiration header: ${expirationHeader}`);
  if (daysLeft !== null && daysLeft < TOKEN_MIN_DAYS) {
    failures.push(`token expires in ${daysLeft} day(s); rotate EVIDENCE_GITHUB_TOKEN`);
  }
  return {
    result: failures.length === 0 ? "pass" : "fail",
    summary:
      failures.length === 0
        ? daysLeft === null
          ? "Token valid; no expiration reported."
          : `Token valid for ${daysLeft} more days.`
        : failures[0]!,
    failures,
    outputs: { status, expiresAt: expiresAt?.toISOString() ?? null, daysLeft }
  };
}

export async function checkCredentialExpiry(client: GithubClient): Promise<CheckOutcome> {
  const response = await client.get("/repos/{repo}");
  const outcome = evaluateCredentialExpiry(
    response.status,
    response.headers.get("github-authentication-token-expiration")
  );
  return { ...outcome, inputs: { repo: client.repo } };
}
