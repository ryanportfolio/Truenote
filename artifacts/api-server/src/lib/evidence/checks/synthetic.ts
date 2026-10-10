import { randomBytes } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../db-client.js";
import { classificationRank, parseClassification } from "../../security/classification.js";
import type { CheckOutcome } from "../receipts.js";

/**
 * Synthetic behavior checks (docs/security/evidence-harness.md, phase 2).
 * Two synthetic CSR accounts log in over HTTPS like any user and probe the
 * access controls against canary documents in two synthetic programs:
 * program isolation, the classification ceiling, the demo-account write
 * block and refusal of a wrong password. A fifth check reads the audit log
 * and confirms that every synthetic login and recorded login attempt
 * happened inside a harness run.
 *
 * Outcomes record emails, document ids, status codes, source doc ids, session
 * ids and the names of response fields that held a canary. Passwords and
 * canary tokens are never recorded. Every session a check opens is logged
 * out in a finally block, also after the runner's time limit aborted the
 * check: once the signal fires, no request but the logouts goes out. A
 * logout that fails is retried once; one still failed after its retry turns
 * a `pass` into `error` and leaves a `fail` a `fail`.
 */

export interface SyntheticCredentials { email: string; password: string }
export interface CanaryDoc { documentId: string; token: string }
export interface SyntheticConfig {
  baseUrl: string;
  csrA: SyntheticCredentials;
  csrB: SyntheticCredentials;
  canaries: { a: CanaryDoc; b: CanaryDoc; aConfidential: CanaryDoc };
}
export interface DocumentFacts {
  programId: string; classification: string; lifecycleState: string; isActive: boolean; isSyntheticProgram: boolean;
}
export interface AccountFacts { maxClassification: string; isSynthetic: boolean; programId: string }
export interface SyntheticDeps {
  accountFacts(email: string): Promise<AccountFacts | null>;
  documentFacts(documentId: string): Promise<DocumentFacts | null>;
  /** Login events of synthetic accounts, any outcome (success or denied), also of deleted ones (actor email ending in .invalid). */
  syntheticLogins(since: Date): Promise<Array<{ occurredAt: string; email: string | null; outcome?: string | null }>>;
  syntheticRunWindows(since: Date): Promise<Array<{ startedAt: string; finishedAt: string }>>;
  now(): Date;
}
export class SyntheticConfigError extends Error {}

export const DEFAULT_SYNTHETIC_BASE_URL = "https://truenote.org";
export const SESSION_COOKIE = "kbase_session";
/**
 * The login actions of every path: password, break-glass and SSO
 * (routes/auth.ts, routes/oidc.ts, lib/auth/mfa.ts). auth.local.login and
 * auth.oidc.login record refusals too (outcome denied), such as a local login
 * refused by LOCAL_LOGIN_MODE or by an account lock; a plain wrong password
 * records none of them (it only counts toward the lock).
 */
export const LOGIN_ACTIONS = ["auth.local.login", "auth.break_glass.login", "auth.oidc.login"] as const;
const ASK_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const LOGOUT_TIMEOUT_MS = 10_000;
/**
 * Upper bound on one synthetic check's HTTP time. The longest is program
 * isolation: three asks, five other requests (two logins, two document
 * reads, one session read) and two logouts, each retried once when it
 * fails, so four logout requests. Bad password refusal also opens at most two
 * sessions (four logout requests) but sends fewer other requests. The
 * runner's time limit for synthetic checks must exceed this plus the
 * database reads.
 */
export const SYNTHETIC_HTTP_WORST_CASE_MS = 3 * ASK_TIMEOUT_MS + 5 * REQUEST_TIMEOUT_MS + 4 * LOGOUT_TIMEOUT_MS;
const LOGIN_LOOKBACK_MS = 8 * 86_400_000;
const WINDOW_SLACK_MS = 2 * 60_000;
const USER_AGENT = "truenote-evidence-harness (+https://truenote.org/.well-known/security.txt)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ config

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntheticConfigError(`EVIDENCE_SYNTHETIC_ACCOUNTS: ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyntheticConfigError(`EVIDENCE_SYNTHETIC_ACCOUNTS: ${field} must be a non-empty string`);
  }
  return value;
}

function credentials(value: unknown, field: string): SyntheticCredentials {
  const o = object(value, field);
  const email = text(o.email, `${field}.email`).trim().toLowerCase();
  // Synthetic users always have .invalid emails (0019_synthetic_fence.sql),
  // so the harness can never log in as a real person.
  if (!email.endsWith(".invalid")) {
    throw new SyntheticConfigError(`EVIDENCE_SYNTHETIC_ACCOUNTS: ${field}.email must end in .invalid`);
  }
  return { email, password: text(o.password, `${field}.password`) };
}

function canary(value: unknown, field: string): CanaryDoc {
  const o = object(value, field);
  const documentId = text(o.documentId, `${field}.documentId`).trim();
  if (!UUID.test(documentId)) {
    throw new SyntheticConfigError(`EVIDENCE_SYNTHETIC_ACCOUNTS: ${field}.documentId must be a UUID`);
  }
  return { documentId, token: text(o.token, `${field}.token`).trim() };
}

/** raw = EVIDENCE_SYNTHETIC_ACCOUNTS JSON {csrA, csrB, canaries}; baseUrl defaults to "https://truenote.org". Throws SyntheticConfigError when raw is missing, not JSON, or incomplete. */
export function parseSyntheticConfig(raw: string | undefined, baseUrl?: string): SyntheticConfig {
  if (raw === undefined || raw.trim() === "") {
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_ACCOUNTS is not set");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The JSON parser's message can quote the input, which holds passwords.
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_ACCOUNTS is not valid JSON");
  }
  const root = object(parsed, "the value");
  const canaries = object(root.canaries, "canaries");
  const config: SyntheticConfig = {
    baseUrl: normalizeBaseUrl(baseUrl),
    csrA: credentials(root.csrA, "csrA"),
    csrB: credentials(root.csrB, "csrB"),
    canaries: {
      a: canary(canaries.a, "canaries.a"),
      b: canary(canaries.b, "canaries.b"),
      aConfidential: canary(canaries.aConfidential, "canaries.aConfidential")
    }
  };
  if (config.csrA.email === config.csrB.email) {
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_ACCOUNTS: csrA and csrB must be different accounts");
  }
  const ids = new Set(Object.values(config.canaries).map((c) => c.documentId.toLowerCase()));
  const tokens = new Set(Object.values(config.canaries).map((c) => c.token));
  if (ids.size !== 3 || tokens.size !== 3) {
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_ACCOUNTS: the three canaries need distinct document ids and tokens");
  }
  return config;
}

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const value = baseUrl === undefined || baseUrl.trim() === "" ? DEFAULT_SYNTHETIC_BASE_URL : baseUrl.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_BASE_URL is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SyntheticConfigError("EVIDENCE_SYNTHETIC_BASE_URL must be http or https");
  }
  return url.origin;
}

// -------------------------------------------------------------------- HTTP

interface HttpResponse {
  /** 0 when no response arrived (network error or timeout). */
  status: number;
  body: unknown;
  cookie: string | null;
  error: string | null;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, 200);
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const code = typeof cause?.code === "string" ? cause.code : null;
  return `${error.name}${code ? ` ${code}` : ""}`;
}

async function call(
  cfg: SyntheticConfig,
  method: "GET" | "POST",
  path: string,
  options: { cookie?: string | null; json?: unknown; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<HttpResponse> {
  // After the runner's time limit the check may still be running; it must
  // not send anything more. Logouts pass no signal and still go out.
  if (options.signal?.aborted) {
    return { status: 0, body: null, cookie: null, error: "aborted after the runner's time limit" };
  }
  const timeout = AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
  if (method !== "GET") {
    headers.origin = cfg.baseUrl;
    headers["content-type"] = "application/json";
  }
  if (options.cookie) headers.cookie = `${SESSION_COOKIE}=${options.cookie}`;
  try {
    const response = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      redirect: "manual",
      signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    });
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const prefix = `${SESSION_COOKIE}=`;
    const cookie =
      response.headers
        .getSetCookie()
        .map((header) => header.split(";")[0]?.trim() ?? "")
        .find((pair) => pair.startsWith(prefix) && pair.length > prefix.length)
        ?.slice(prefix.length) ?? null;
    return { status: response.status, body, cookie, error: null };
  } catch (error) {
    return { status: 0, body: null, cookie: null, error: describeError(error) };
  }
}

function statusText(response: { status: number; error: string | null }): string {
  return response.status === 0 ? `no response (${response.error ?? "unknown error"})` : String(response.status);
}

function succeeded(response: HttpResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/**
 * Tracks every session a check opens so the finally block can log all of
 * them out. A logout that fails (non-2xx or no response) is retried once;
 * one still failed after its retry is described in `failed`, by the
 * account's email and the statuses, never by the cookie.
 */
class Sessions {
  private readonly open: Array<{ cookie: string; email: string }> = [];
  /** Status of every logout request, retries included; 0 is no response. */
  readonly logouts: Array<number> = [];
  readonly failed: string[] = [];

  constructor(
    private readonly cfg: SyntheticConfig,
    private readonly signal?: AbortSignal
  ) {}

  async login(email: string, password: string): Promise<HttpResponse> {
    const response = await call(this.cfg, "POST", "/api/auth/login", { json: { email, password }, signal: this.signal });
    if (response.cookie) this.open.push({ cookie: response.cookie, email });
    return response;
  }

  /** Logouts pass no signal, so they still go out after the runner's time limit. */
  async closeAll(): Promise<void> {
    while (this.open.length > 0) {
      const { cookie, email } = this.open.pop()!;
      const first = await call(this.cfg, "POST", "/api/auth/logout", { cookie, timeoutMs: LOGOUT_TIMEOUT_MS });
      this.logouts.push(first.status);
      if (succeeded(first)) continue;
      const retry = await call(this.cfg, "POST", "/api/auth/logout", { cookie, timeoutMs: LOGOUT_TIMEOUT_MS });
      this.logouts.push(retry.status);
      if (succeeded(retry)) continue;
      this.failed.push(
        `logout of a ${email} session answered ${statusText(first)}, then ${statusText(retry)} on its retry, so the session may still be open`
      );
    }
  }
}

/**
 * Logs out every open session and records the logouts. A logout still failed
 * after its retry is an error: it turns a pass into `error` and leaves a
 * `fail` a `fail` (Findings.outcome), so a leak is never hidden by cleanup.
 */
async function closeSessions(f: Findings, sessions: Sessions): Promise<void> {
  await sessions.closeAll();
  f.outputs.logouts = sessions.logouts;
  if (sessions.failed.length > 0) {
    f.outputs.failedLogouts = [...sessions.failed];
    f.errors.push(...sessions.failed);
  }
}

interface AskObservation {
  status: string;
  sessionId: string | null;
  sourceDocIds: string[];
  refused: boolean | null;
  /** Response fields that held the foreign canary, by name ("sources[0].excerpt", "answer"). Only for probes. */
  leakedIn?: string[];
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function holdsToken(value: unknown, token: string): boolean {
  return typeof value === "string" && value.toLowerCase().includes(token.toLowerCase());
}

/**
 * Where a response shows a canary: a source with its doc_id, a source whose
 * excerpt or doc_title holds its token (doc_id is nullable, lib/citations.ts),
 * or an answer text holding its token. Returns field names, never the token.
 */
function leakFields(body: { answer?: unknown; sources?: unknown }, foreign: CanaryDoc): string[] {
  const fields: string[] = [];
  const sources = Array.isArray(body.sources) ? (body.sources as unknown[]) : [];
  sources.forEach((source, i) => {
    if (!source || typeof source !== "object") return;
    const s = source as { doc_id?: unknown; excerpt?: unknown; doc_title?: unknown };
    if (typeof s.doc_id === "string" && sameId(s.doc_id, foreign.documentId)) fields.push(`sources[${i}].doc_id`);
    if (holdsToken(s.excerpt, foreign.token)) fields.push(`sources[${i}].excerpt`);
    if (holdsToken(s.doc_title, foreign.token)) fields.push(`sources[${i}].doc_title`);
  });
  if (holdsToken(body.answer, foreign.token)) fields.push("answer");
  return fields;
}

/** Ask with `canary`'s token. With `foreign` set, the observation lists every field that shows that canary. */
async function ask(
  cfg: SyntheticConfig,
  cookie: string,
  canary: CanaryDoc,
  signal: AbortSignal | undefined,
  foreign?: CanaryDoc
): Promise<AskObservation & { ok: boolean }> {
  const response = await call(cfg, "POST", "/api/ask", {
    cookie,
    json: { question: `Synthetic access check: what does the knowledge base say about ${canary.token}?` },
    timeoutMs: ASK_TIMEOUT_MS,
    signal
  });
  const body = (response.body ?? {}) as { sessionId?: unknown; sources?: unknown; refused?: unknown; answer?: unknown };
  const sources = Array.isArray(body.sources) ? (body.sources as Array<{ doc_id?: unknown } | null>) : null;
  return {
    ok: response.status === 200 && sources !== null,
    status: statusText(response),
    sessionId: typeof body.sessionId === "string" ? body.sessionId : null,
    sourceDocIds: [...new Set((sources ?? []).map((s) => (typeof s?.doc_id === "string" ? s.doc_id : null)).filter((id): id is string => id !== null))],
    refused: typeof body.refused === "boolean" ? body.refused : null,
    ...(foreign ? { leakedIn: leakFields(body, foreign) } : {})
  };
}

// ---------------------------------------------------------------- outcomes

/** `fail` when a control did not hold, else `error` when evidence is missing, else `pass`. */
class Findings {
  readonly failures: string[] = [];
  readonly errors: string[] = [];
  readonly outputs: Record<string, unknown> = {};

  outcome(passSummary: string, inputs: Record<string, unknown>): CheckOutcome {
    if (this.failures.length > 0) {
      return {
        result: "fail",
        summary: `${this.failures.length} access condition(s) did not hold.`,
        failures: [...this.failures, ...this.errors],
        inputs,
        outputs: this.outputs
      };
    }
    if (this.errors.length > 0) {
      return {
        result: "error",
        summary: `No evidence for this run: ${this.errors[0]}`,
        failures: [...this.errors],
        inputs,
        outputs: this.outputs
      };
    }
    return { result: "pass", summary: passSummary, failures: [], inputs, outputs: this.outputs };
  }
}

/** Expect a refused read: 404 holds, 2xx leaks, anything else is no evidence. */
function expectNotFound(f: Findings, label: string, response: HttpResponse): void {
  if (response.status === 404) return;
  if (response.status >= 200 && response.status < 300) f.failures.push(`${label} answered ${response.status}, expected 404`);
  else f.errors.push(`${label} answered ${statusText(response)}, expected 404`);
}

function liveCanaryProblems(label: string, facts: DocumentFacts | null): string[] {
  if (!facts) return [`canary ${label} is not in the database`];
  const problems: string[] = [];
  if (!facts.isSyntheticProgram) problems.push(`canary ${label} is not in a synthetic program`);
  if (facts.lifecycleState !== "active") problems.push(`canary ${label} lifecycle_state is ${facts.lifecycleState}, not active`);
  if (!facts.isActive) problems.push(`canary ${label} active version is not is_active`);
  return problems;
}

/** The account exists, is synthetic, and sits in the program of the canary named `canaryLabel`. */
function accountProblems(label: string, facts: AccountFacts | null, canaryLabel: string, canaryFacts: DocumentFacts | null): string[] {
  if (!facts) return [`${label} is not in the database`];
  const problems: string[] = [];
  if (!facts.isSynthetic) problems.push(`${label} is not a synthetic account`);
  if (canaryFacts && facts.programId !== canaryFacts.programId) problems.push(`${label} is not in canary ${canaryLabel}'s program`);
  return problems;
}

/** Rank of a classification or clearance (lib/security/classification.ts); null when unknown. */
function rankOf(value: string): number | null {
  const parsed = parseClassification(value);
  return parsed ? classificationRank(parsed) : null;
}

function baseInputs(cfg: SyntheticConfig): Record<string, unknown> {
  return {
    baseUrl: cfg.baseUrl,
    csrA: cfg.csrA.email,
    csrB: cfg.csrB.email,
    canaries: {
      a: cfg.canaries.a.documentId,
      b: cfg.canaries.b.documentId,
      aConfidential: cfg.canaries.aConfidential.documentId
    }
  };
}

// ------------------------------------------------------- program isolation

export async function checkProgramIsolation(cfg: SyntheticConfig, deps: SyntheticDeps, signal?: AbortSignal): Promise<CheckOutcome> {
  const f = new Findings();
  const inputs: Record<string, unknown> = baseInputs(cfg);
  const { a, b } = cfg.canaries;

  // Database preconditions: both canaries live, in different synthetic
  // programs; csr-a and csr-b synthetic, each in its own canary's program;
  // and b within csr-a's clearance, so only program scoping can explain
  // csr-a not seeing b.
  const factsA = await deps.documentFacts(a.documentId);
  const factsB = await deps.documentFacts(b.documentId);
  const accountA = await deps.accountFacts(cfg.csrA.email);
  const accountB = await deps.accountFacts(cfg.csrB.email);
  f.outputs.documentFacts = { a: factsA, b: factsB };
  f.outputs.accountFacts = { csrA: accountA, csrB: accountB };
  if (accountA) inputs.csrAClearance = accountA.maxClassification;
  f.errors.push(...liveCanaryProblems("a", factsA), ...liveCanaryProblems("b", factsB));
  if (factsA && factsB && factsA.programId === factsB.programId) f.errors.push("canaries a and b are in the same program");
  f.errors.push(...accountProblems("csr-a", accountA, "a", factsA), ...accountProblems("csr-b", accountB, "b", factsB));
  if (accountA && accountB && accountA.programId === accountB.programId) f.errors.push("csr-a and csr-b are in the same program");
  if (accountA && factsB) {
    const clearance = rankOf(accountA.maxClassification);
    const level = rankOf(factsB.classification);
    if (clearance === null || level === null) {
      f.errors.push(`cannot compare canary b (${factsB.classification}) with csr-a's clearance (${accountA.maxClassification})`);
    } else if (level > clearance) {
      f.errors.push(
        `canary b is ${factsB.classification}, above csr-a's clearance ${accountA.maxClassification}, so its absence would not prove isolation`
      );
    }
  }
  if (f.errors.length > 0) return f.outcome("", inputs);

  const sessions = new Sessions(cfg, signal);
  // The probes return early on a missing precondition; the outcome is built
  // only after the finally block, so it includes the logout results.
  const probe = async (): Promise<void> => {
    // csr-b: a chat session owned by csr-b, and the b positive control.
    let bSessionId: string | null = null;
    const loginB = await sessions.login(cfg.csrB.email, cfg.csrB.password);
    f.outputs.csrBLogin = statusText(loginB);
    if (loginB.status !== 200 || !loginB.cookie) {
      f.errors.push(`csr-b login answered ${statusText(loginB)}`);
    } else {
      const askB = await ask(cfg, loginB.cookie, b, signal);
      const { ok, ...observed } = askB;
      f.outputs.csrBAskB = observed;
      if (!ok || !askB.sessionId) f.errors.push(`csr-b ask answered ${askB.status} without a session id and sources`);
      else {
        bSessionId = askB.sessionId;
        if (!askB.sourceDocIds.some((id) => sameId(id, b.documentId))) {
          f.errors.push("positive control: csr-b did not retrieve canary b");
        }
      }
    }

    const loginA = await sessions.login(cfg.csrA.email, cfg.csrA.password);
    f.outputs.csrALogin = statusText(loginA);
    if (loginA.status !== 200 || !loginA.cookie) {
      f.errors.push(`csr-a login answered ${statusText(loginA)}`);
      return;
    }
    const cookieA = loginA.cookie;

    // Positive controls for csr-a: own canary by ask and by id.
    const askA = await ask(cfg, cookieA, a, signal);
    const { ok: askAOk, ...askAObserved } = askA;
    f.outputs.csrAAskA = askAObserved;
    if (!askAOk) f.errors.push(`positive control: csr-a ask for canary a answered ${askA.status}`);
    else if (!askA.sourceDocIds.some((id) => sameId(id, a.documentId))) {
      f.errors.push("positive control: csr-a did not retrieve canary a");
    }
    const docA = await call(cfg, "GET", `/api/kb/documents/${encodeURIComponent(a.documentId)}`, { cookie: cookieA, signal });
    f.outputs.csrAGetDocA = statusText(docA);
    if (docA.status !== 200) f.errors.push(`positive control: csr-a GET document a answered ${statusText(docA)}, expected 200`);

    // Probes across the program boundary.
    const askCross = await ask(cfg, cookieA, b, signal, b);
    const { ok: askCrossOk, ...askCrossObserved } = askCross;
    f.outputs.csrAAskB = askCrossObserved;
    const crossLeaks = askCross.leakedIn ?? [];
    if (crossLeaks.length > 0) {
      f.failures.push(`csr-a's ask showed canary b from program B in: ${crossLeaks.join(", ")}`);
    } else if (!askCrossOk) {
      f.errors.push(`csr-a ask for canary b answered ${askCross.status}`);
    }
    const docB = await call(cfg, "GET", `/api/kb/documents/${encodeURIComponent(b.documentId)}`, { cookie: cookieA, signal });
    f.outputs.csrAGetDocB = statusText(docB);
    expectNotFound(f, "csr-a GET document b", docB);
    if (bSessionId) {
      const sessionB = await call(cfg, "GET", `/api/sessions/${encodeURIComponent(bSessionId)}`, { cookie: cookieA, signal });
      f.outputs.csrAGetSessionB = { sessionId: bSessionId, status: statusText(sessionB) };
      expectNotFound(f, "csr-a GET csr-b's session", sessionB);
    }
  };
  try {
    await probe();
  } finally {
    await closeSessions(f, sessions);
  }
  return f.outcome(
    "csr-a retrieved its own canary, and canary b, csr-b's document and csr-b's session were all withheld from csr-a.",
    inputs
  );
}

// -------------------------------------------------- classification ceiling

export async function checkClassificationCeiling(cfg: SyntheticConfig, deps: SyntheticDeps, signal?: AbortSignal): Promise<CheckOutcome> {
  const f = new Findings();
  const inputs: Record<string, unknown> = baseInputs(cfg);
  const { a, aConfidential: c } = cfg.canaries;

  // Database preconditions: the canary aConfidential is live, in canary a's
  // program, and above csr-a's clearance; csr-a is synthetic and in that
  // program. Then only the clearance filter can explain csr-a not seeing it.
  const factsC = await deps.documentFacts(c.documentId);
  const factsA = await deps.documentFacts(a.documentId);
  const accountA = await deps.accountFacts(cfg.csrA.email);
  f.outputs.documentFacts = { aConfidential: factsC, a: factsA };
  f.outputs.accountFacts = { csrA: accountA };
  const clearance = accountA?.maxClassification ?? null;
  if (clearance !== null) inputs.csrAClearance = clearance;
  f.errors.push(...liveCanaryProblems("aConfidential", factsC));
  if (!factsA) f.errors.push("canary a is not in the database");
  else if (factsC && factsA.programId !== factsC.programId) {
    f.errors.push("canaries a and aConfidential are in different programs");
  }
  f.errors.push(...accountProblems("csr-a", accountA, "aConfidential", factsC));
  if (accountA && factsC) {
    const clearanceRank = rankOf(accountA.maxClassification);
    const level = rankOf(factsC.classification);
    if (clearanceRank === null || level === null) {
      f.errors.push(`cannot compare canary aConfidential (${factsC.classification}) with csr-a's clearance (${accountA.maxClassification})`);
    } else if (level <= clearanceRank) {
      f.errors.push(`canary aConfidential is ${factsC.classification}, not above csr-a's clearance ${accountA.maxClassification}`);
    }
  }
  if (f.errors.length > 0) return f.outcome("", inputs);

  const sessions = new Sessions(cfg, signal);
  // The outcome is built after the finally block, so it includes the logouts.
  const probe = async (): Promise<void> => {
    const loginA = await sessions.login(cfg.csrA.email, cfg.csrA.password);
    f.outputs.csrALogin = statusText(loginA);
    if (loginA.status !== 200 || !loginA.cookie) {
      f.errors.push(`csr-a login answered ${statusText(loginA)}`);
      return;
    }
    const cookieA = loginA.cookie;

    const askA = await ask(cfg, cookieA, a, signal);
    const { ok: askAOk, ...askAObserved } = askA;
    f.outputs.csrAAskA = askAObserved;
    if (!askAOk) f.errors.push(`positive control: csr-a ask for canary a answered ${askA.status}`);
    else if (!askA.sourceDocIds.some((id) => sameId(id, a.documentId))) {
      f.errors.push("positive control: csr-a did not retrieve canary a");
    }
    const docA = await call(cfg, "GET", `/api/kb/documents/${encodeURIComponent(a.documentId)}`, { cookie: cookieA, signal });
    f.outputs.csrAGetDocA = statusText(docA);
    if (docA.status !== 200) f.errors.push(`positive control: csr-a GET document a answered ${statusText(docA)}, expected 200`);

    const askC = await ask(cfg, cookieA, c, signal, c);
    const { ok: askCOk, ...askCObserved } = askC;
    f.outputs.csrAAskAConfidential = askCObserved;
    const ceilingLeaks = askC.leakedIn ?? [];
    if (ceilingLeaks.length > 0) {
      f.failures.push(
        `csr-a (clearance ${clearance}) was shown the ${factsC!.classification} canary by ask in: ${ceilingLeaks.join(", ")}`
      );
    } else if (!askCOk) {
      f.errors.push(`csr-a ask for canary aConfidential answered ${askC.status}`);
    }
    const docC = await call(cfg, "GET", `/api/kb/documents/${encodeURIComponent(c.documentId)}`, { cookie: cookieA, signal });
    f.outputs.csrAGetDocAConfidential = statusText(docC);
    expectNotFound(f, "csr-a GET document aConfidential", docC);
  };
  try {
    await probe();
  } finally {
    await closeSessions(f, sessions);
  }
  return f.outcome(
    `csr-a (clearance ${clearance}) retrieved its own canary but not the ${factsC!.classification} canary in the same program, by ask or by id.`,
    inputs
  );
}

// ------------------------------------------------------- demo write block

/**
 * Statuses that show the upload reached past the demo block. 401 (session
 * lost), 403 without code demo_account (another guard, such as the origin
 * check), 408, 423 (requireFreshPassword runs before blockDemoWrites on the
 * documents router and answers "Password reset required") and 429 say
 * nothing about the block; 5xx and no response neither.
 */
function passedDemoBlock(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && ![401, 403, 408, 423, 429].includes(status);
}

export async function checkDemoWriteBlock(cfg: SyntheticConfig, _deps: SyntheticDeps, signal?: AbortSignal): Promise<CheckOutcome> {
  const f = new Findings();
  const inputs: Record<string, unknown> = { baseUrl: cfg.baseUrl, probe: "POST /api/documents/upload with no body" };
  const config = await call(cfg, "GET", "/api/config", { signal });
  f.outputs.config = statusText(config);
  if (config.status !== 200) {
    f.errors.push(`GET /api/config answered ${statusText(config)}`);
    return f.outcome("", inputs);
  }
  const published = (config.body as { demoAccounts?: unknown } | null)?.demoAccounts;
  const accounts = Array.isArray(published)
    ? (published as Array<{ label?: unknown; email?: unknown; password?: unknown; role?: unknown }>)
    : [];
  f.outputs.demoAccounts = accounts.map((account) => ({
    label: typeof account.label === "string" ? account.label : null,
    email: typeof account.email === "string" ? account.email : null,
    role: typeof account.role === "string" ? account.role : null
  }));
  if (accounts.length === 0) {
    return f.outcome("No demo accounts are published, so there is no demo account to block.", inputs);
  }
  const manager = accounts.find(
    (account) => account.role === "manager" && typeof account.email === "string" && typeof account.password === "string"
  );
  if (!manager) {
    f.errors.push("no published demo account has role manager; a csr is stopped by the role check, which does not prove the demo block");
    return f.outcome("", inputs);
  }
  inputs.demoAccount = manager.email;

  const sessions = new Sessions(cfg, signal);
  // The outcome is built after the finally block, so it includes the logouts.
  const probe = async (): Promise<void> => {
    const login = await sessions.login(manager.email as string, manager.password as string);
    f.outputs.login = statusText(login);
    if (login.status !== 200 || !login.cookie) {
      f.errors.push(`demo manager login answered ${statusText(login)}`);
      return;
    }
    const upload = await call(cfg, "POST", "/api/documents/upload", { cookie: login.cookie, signal });
    const code = (upload.body as { code?: unknown } | null)?.code;
    f.outputs.upload = { status: statusText(upload), code: typeof code === "string" ? code : null };
    if (upload.status === 403 && code === "demo_account") {
      // Held.
    } else if (passedDemoBlock(upload.status)) {
      // A 2xx, or a handler's own 4xx such as 400 "file is required": the
      // request got past the demo block.
      f.failures.push(`demo manager upload answered ${upload.status}${typeof code === "string" ? ` (${code})` : ""}, not 403 demo_account`);
    } else {
      f.errors.push(`demo manager upload answered ${statusText(upload)}${typeof code === "string" ? ` (${code})` : ""}, expected 403 demo_account`);
    }
  };
  try {
    await probe();
  } finally {
    await closeSessions(f, sessions);
  }
  return f.outcome("The demo manager account's upload was refused with 403 demo_account.", inputs);
}

// ---------------------------------------------------- bad password refusal

/**
 * Positive control first: csr-a logs in with the right password and out
 * again. Without it a server that refuses every csr-a login (LOCAL_LOGIN_MODE
 * break_glass or disabled answers 401 to any password) would pass. The
 * success also resets csr-a's failed-login count, so the one wrong password
 * after it never comes near the account lock. A control logout still failed
 * after its retry (non-2xx or no response) ends the check with `error`
 * before the wrong-password attempt.
 */
export async function checkBadPasswordRefused(cfg: SyntheticConfig, _deps: SyntheticDeps, signal?: AbortSignal): Promise<CheckOutcome> {
  const f = new Findings();
  const inputs = {
    baseUrl: cfg.baseUrl,
    account: cfg.csrA.email,
    control: "one login with the right password, then logout",
    attempts: 1,
    password: "random, not recorded"
  };
  const wrongPassword = `wrong-${randomBytes(24).toString("base64url")}`;
  const sessions = new Sessions(cfg, signal);
  // Logouts and failed logouts up to these indexes belong to the control.
  let controlLogoutCount = 0;
  let controlFailedCount = 0;
  // The outcome is built after the finally block, so it includes the logouts.
  const probe = async (): Promise<void> => {
    const control = await sessions.login(cfg.csrA.email, cfg.csrA.password);
    f.outputs.controlLogin = statusText(control);
    await sessions.closeAll();
    controlLogoutCount = sessions.logouts.length;
    controlFailedCount = sessions.failed.length;
    f.outputs.controlLogouts = sessions.logouts.slice(0, controlLogoutCount);
    if (control.status !== 200 || !control.cookie) {
      f.errors.push(
        `csr-a login with the right password answered ${statusText(control)}${control.status === 200 ? " without a session cookie" : ""}, ` +
          "so a refused wrong password would prove nothing"
      );
    }
    if (controlFailedCount > 0) {
      const failed = sessions.failed.slice(0, controlFailedCount);
      f.outputs.controlFailedLogouts = failed;
      f.errors.push(...failed.map((line) => `control ${line}; the positive control did not complete`));
    }
    if (f.errors.length > 0) return;
    const login = await sessions.login(cfg.csrA.email, wrongPassword);
    f.outputs.login = statusText(login);
    if (login.status === 401) {
      // Held.
    } else if (login.status === 200) {
      f.failures.push("login with a random wrong password answered 200");
    } else {
      f.errors.push(`login with a wrong password answered ${statusText(login)}, expected 401`);
    }
  };
  try {
    await probe();
  } finally {
    await sessions.closeAll();
    // Only the logouts after the control; the control's are in controlLogouts.
    f.outputs.logouts = sessions.logouts.slice(controlLogoutCount);
    const failed = sessions.failed.slice(controlFailedCount);
    if (failed.length > 0) {
      f.outputs.failedLogouts = failed;
      f.errors.push(...failed);
    }
  }
  return f.outcome(
    "csr-a logged in with the right password (200), then one login with a random wrong password was refused with 401.",
    inputs
  );
}

// ---------------------------------------------------------- login windows

/** Reads only the database, so it runs without EVIDENCE_SYNTHETIC_ACCOUNTS (cfg null). */
export async function checkSyntheticLoginWindows(_cfg: SyntheticConfig | null, deps: SyntheticDeps): Promise<CheckOutcome> {
  const f = new Findings();
  const now = deps.now();
  const since = new Date(now.getTime() - LOGIN_LOOKBACK_MS);
  const inputs = { since: since.toISOString(), slackSeconds: WINDOW_SLACK_MS / 1000, actions: [...LOGIN_ACTIONS] };
  const logins = await deps.syntheticLogins(since);
  const windows = await deps.syntheticRunWindows(since);
  const spans = windows
    .map((w) => ({ start: Date.parse(w.startedAt) - WINDOW_SLACK_MS, end: Date.parse(w.finishedAt) + WINDOW_SLACK_MS }))
    .filter((span) => Number.isFinite(span.start) && Number.isFinite(span.end));
  const outside = logins.filter((login) => {
    const at = Date.parse(login.occurredAt);
    return !Number.isFinite(at) || !spans.some((span) => at >= span.start && at <= span.end);
  });
  f.outputs.logins = logins.length;
  f.outputs.runWindows = windows.length;
  f.outputs.outside = outside.map((login) => ({ occurredAt: login.occurredAt, email: login.email, outcome: login.outcome ?? null }));
  for (const login of outside) {
    f.failures.push(
      `synthetic login event at ${login.occurredAt} (${login.email ?? "unknown email"}, outcome ${login.outcome ?? "unknown"}) ` +
        "is outside every harness run"
    );
  }
  return f.outcome(
    logins.length === 0
      ? "No synthetic logins or recorded login attempts in the last 8 days."
      : `All ${logins.length} synthetic login event(s) (logins and refused attempts) in the last 8 days fall inside ` +
          `${windows.length} recorded harness run window(s).`,
    inputs
  );
}

// -------------------------------------------------------------- real deps

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

/** Real deps backed by the database (db from ../../db-client.js) and the clock. */
export function syntheticDepsFromDb(): SyntheticDeps {
  const executor = db as unknown as Executor;
  return {
    async accountFacts(email) {
      const result = await executor.execute(sql`
        SELECT max_classification AS "maxClassification",
               is_synthetic AS "isSynthetic",
               program_id::text AS "programId"
        FROM users
        WHERE lower(email) = lower(${email})
        LIMIT 1
      `);
      const row = result.rows[0] as { maxClassification: string; isSynthetic: boolean; programId: string | null } | undefined;
      if (!row) return null;
      return {
        maxClassification: row.maxClassification,
        isSynthetic: row.isSynthetic === true,
        programId: row.programId ?? ""
      };
    },
    async documentFacts(documentId) {
      const result = await executor.execute(sql`
        SELECT d.program_id::text AS "programId",
               COALESCE(p.is_synthetic, false) AS "isSyntheticProgram",
               COALESCE(v.classification, 'none') AS classification,
               CASE WHEN d.lifecycle_state <> 'active' THEN 'document ' || d.lifecycle_state
                    ELSE COALESCE(v.lifecycle_state, 'no current version') END AS "lifecycleState",
               COALESCE(v.is_active, false) AS "isActive"
        FROM documents d
        LEFT JOIN programs p ON p.id = d.program_id
        LEFT JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.id = ${documentId}::uuid
      `);
      const row = result.rows[0] as
        | { programId: string | null; isSyntheticProgram: boolean; classification: string; lifecycleState: string; isActive: boolean }
        | undefined;
      if (!row) return null;
      return {
        programId: row.programId ?? "",
        classification: row.classification,
        lifecycleState: row.lifecycleState,
        isActive: row.isActive === true,
        isSyntheticProgram: row.isSyntheticProgram === true
      };
    },
    async syntheticLogins(since) {
      // A synthetic user row can be deleted after deactivation; its events
      // keep actor_user_id and actor_email. The fence (0019) makes an email
      // ending in .invalid equivalent to a synthetic user, so such an event
      // counts even when no users row matches.
      const result = await executor.execute(sql`
        SELECT to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
               COALESCE(e.actor_email, u.email) AS email,
               e.outcome
        FROM security_events e
        LEFT JOIN users u ON u.id = e.actor_user_id
        WHERE e.action IN ${[...LOGIN_ACTIONS]}
          AND (u.is_synthetic IS TRUE OR lower(e.actor_email) LIKE '%.invalid')
          AND e.occurred_at >= ${since.toISOString()}::timestamptz
        ORDER BY e.occurred_at
      `);
      return result.rows as Array<{ occurredAt: string; email: string | null; outcome: string | null }>;
    },
    async syntheticRunWindows(since) {
      const result = await executor.execute(sql`
        SELECT payload::jsonb ->> 'startedAt' AS "startedAt",
               payload::jsonb ->> 'finishedAt' AS "finishedAt"
        FROM evidence_receipts
        WHERE check_kind = 'synthetic'
          AND recorded_at >= ${since.toISOString()}::timestamptz
        ORDER BY recorded_at
      `);
      return (result.rows as Array<{ startedAt: string | null; finishedAt: string | null }>)
        .filter((row): row is { startedAt: string; finishedAt: string } => !!row.startedAt && !!row.finishedAt);
    },
    now: () => new Date()
  };
}
