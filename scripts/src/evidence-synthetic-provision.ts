/**
 * Provision the evidence harness's synthetic accounts and canary documents
 * (docs/security/evidence-harness.md, phase 2;
 * artifacts/api-server/src/lib/evidence/checks/synthetic.ts reads the result).
 *
 * Creates, or brings back in line, two synthetic programs (zz-synthetic-a,
 * zz-synthetic-b) and one synthetic CSR in each, connected as the migration
 * role: lib/db/sql/0019_synthetic_fence.sql lets only that role insert
 * synthetic rows, and no API sets users.max_classification. The three canary
 * documents go through the real upload and ingestion path, uploaded over HTTPS
 * by the agent super_user. The result is written as the JSON
 * EVIDENCE_SYNTHETIC_ACCOUNTS expects:
 *   {csrA:{email,password}, csrB:{email,password},
 *    canaries:{a:{documentId,token}, b:{...}, aConfidential:{...}}}
 *
 * Run by the owner through an SSH tunnel to `pgvector`, as for pgboss-install:
 *   DATABASE_URL=<migration-role URL> pnpm --filter @workspace/scripts run evidence:synthetic-provision
 *   ... evidence:synthetic-provision -- --apply
 *   ... evidence:synthetic-provision -- --apply --rotate-passwords
 *
 * Environment:
 *   DATABASE_URL                      required; the migration role (a superuser)
 *   EVIDENCE_PROVISION_BASE_URL       default https://truenote.org
 *   EVIDENCE_PROVISION_AGENT_FILE     default ~/.claude/secrets/truenote-agent.json ({email, password})
 *   EVIDENCE_PROVISION_OUT            default ~/.claude/secrets/truenote-synthetic-accounts.json
 *   EVIDENCE_PROVISION_POLL_MS        default 5000; interval while waiting for ingestion
 *
 * Without --apply it is a dry run: one READ ONLY transaction, no login, no
 * file written. It prints what --apply would do.
 *
 * Idempotent. An existing user keeps its password, which must then be in the
 * output file and match the stored hash; --rotate-passwords gives both users
 * new ones and, in the same transaction, deletes their sessions and their
 * unconsumed MFA challenges, so nothing opened with an old password stays
 * usable. Other users' sessions are untouched. Canary tokens are reused from the output file. A canary document
 * is reused when the documents list shows it active with the right
 * classification and its id and token are in the output file; otherwise a new
 * version is uploaded and the script waits until ingestion makes it active.
 * The passwords and canary tokens are saved to the output file right after
 * the commit, before the first API call, so when the canary step fails a
 * plain --apply resumes with them.
 *
 * Never prints a password, a canary token, the agent's credentials or
 * DATABASE_URL: every line goes through redact(), and errors print only
 * their message.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Client } from "pg";
import { hashPassword, verifyPassword } from "../../artifacts/api-server/src/lib/auth/passwords.js";

const LOG = "[evidence-synthetic-provision]";
const SESSION_COOKIE = "kbase_session";
const USER_AGENT = "truenote-evidence-provision (+https://truenote.org/.well-known/security.txt)";
const REQUEST_TIMEOUT_MS = 60_000;
const INGESTION_TIMEOUT_MS = 5 * 60_000;
const FAILED_STATES = new Set(["failed", "quarantined", "rejected", "revoked"]);
const SCRIPT = "scripts/src/evidence-synthetic-provision.ts";

type ProgramKey = "a" | "b";
type CanaryKey = "a" | "aConfidential" | "b";
type UserKey = "csrA" | "csrB";

const PROGRAMS: Record<ProgramKey, string> = { a: "zz-synthetic-a", b: "zz-synthetic-b" };
const USERS: Record<UserKey, { email: string; name: string; program: ProgramKey }> = {
  csrA: { email: "csr-a@synthetic.truenote.invalid", name: "Synthetic CSR A", program: "a" },
  csrB: { email: "csr-b@synthetic.truenote.invalid", name: "Synthetic CSR B", program: "b" }
};
const CANARIES: Record<CanaryKey, { program: ProgramKey; classification: string; title: string; file: string }> = {
  a: { program: "a", classification: "internal", title: "Synthetic canary A", file: "synthetic-canary-a.md" },
  aConfidential: {
    program: "a",
    classification: "confidential",
    title: "Synthetic canary A confidential",
    file: "synthetic-canary-a-confidential.md"
  },
  b: { program: "b", classification: "internal", title: "Synthetic canary B", file: "synthetic-canary-b.md" }
};
const CANARY_KEYS: CanaryKey[] = ["a", "aConfidential", "b"];
const USER_KEYS: UserKey[] = ["csrA", "csrB"];
const MIN_PASSWORD_LENGTH = 32;
const MIN_TOKEN_LENGTH = 12;

// ------------------------------------------------------------- redaction

const secrets = new Set<string>();
function secret(value: string): string {
  if (value.length >= 4) secrets.add(value);
  return value;
}
function redact(line: string): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}
function say(line: string): void {
  console.log(redact(`${LOG} ${line}`));
}

// ---------------------------------------------------------------- config

interface Options {
  apply: boolean;
  rotatePasswords: boolean;
  databaseUrl: string;
  baseUrl: string;
  agentFile: string;
  outFile: string;
  pollMs: number;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(homedir(), p.slice(1)) : p;
}

function readOptions(argv: string[]): Options {
  let apply = false;
  let rotatePasswords = false;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--rotate-passwords") rotatePasswords = true;
    else throw new Error(`unknown argument ${arg}; use --apply and --rotate-passwords`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is not set; point it at the migration role");
  secret(databaseUrl);
  const rawBase = process.env.EVIDENCE_PROVISION_BASE_URL?.trim() || "https://truenote.org";
  let baseUrl: string;
  try {
    const url = new URL(rawBase);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    baseUrl = url.origin;
  } catch {
    throw new Error("EVIDENCE_PROVISION_BASE_URL must be an http or https URL");
  }
  const pollRaw = process.env.EVIDENCE_PROVISION_POLL_MS?.trim();
  const pollMs = pollRaw ? Number(pollRaw) : 5000;
  if (!Number.isFinite(pollMs) || pollMs <= 0) throw new Error("EVIDENCE_PROVISION_POLL_MS must be a positive number");
  return {
    apply,
    rotatePasswords,
    databaseUrl,
    baseUrl,
    agentFile: path.resolve(
      expandHome(process.env.EVIDENCE_PROVISION_AGENT_FILE?.trim() || "~/.claude/secrets/truenote-agent.json")
    ),
    outFile: path.resolve(
      expandHome(process.env.EVIDENCE_PROVISION_OUT?.trim() || "~/.claude/secrets/truenote-synthetic-accounts.json")
    ),
    pollMs
  };
}

async function readAgent(file: string): Promise<{ email: string; password: string }> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`cannot read the agent file ${file} (EVIDENCE_PROVISION_AGENT_FILE)`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message can quote the input.
    throw new Error(`the agent file ${file} is not valid JSON`);
  }
  const o = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  if (typeof o.email !== "string" || !o.email.trim() || typeof o.password !== "string" || !o.password) {
    throw new Error(`the agent file ${file} needs non-empty "email" and "password" strings`);
  }
  return { email: secret(o.email.trim()), password: secret(o.password) };
}

/** What a previous run left in the output file; every part is optional. */
interface Previous {
  passwords: Map<string, string>;
  canaries: Partial<Record<CanaryKey, { documentId: string | null; token: string }>>;
}

async function readPrevious(file: string): Promise<Previous> {
  const previous: Previous = { passwords: new Map(), canaries: {} };
  if (!existsSync(file)) return previous;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`the output file ${file} exists but is not valid JSON; move it away or fix it`);
  }
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  for (const key of USER_KEYS) {
    const c = root[key] as Record<string, unknown> | undefined;
    if (c && typeof c.email === "string" && typeof c.password === "string" && c.password) {
      previous.passwords.set(c.email.trim().toLowerCase(), secret(c.password));
    }
  }
  const canaries = (root.canaries ?? {}) as Record<string, unknown>;
  for (const key of CANARY_KEYS) {
    const c = canaries[key] as Record<string, unknown> | undefined;
    if (c && typeof c.token === "string" && c.token.trim().length >= MIN_TOKEN_LENGTH) {
      previous.canaries[key] = {
        token: secret(c.token.trim()),
        documentId: typeof c.documentId === "string" && c.documentId.trim() ? c.documentId.trim() : null
      };
    }
  }
  return previous;
}

// -------------------------------------------------------------- database

// Type aliases, not interfaces: pg's QueryResultRow needs an index signature.
type ProgramRow = { id: string; name: string; is_synthetic: boolean };
type UserRow = {
  id: string; email: string; role: string; program_id: string | null; name: string;
  max_classification: string; must_reset_password: boolean; is_active: boolean; is_synthetic: boolean; password_hash: string;
};

interface DbResult {
  programIds: Record<ProgramKey, string>;
  userIds: Record<UserKey, string>;
  passwords: Record<UserKey, string>;
}

async function checkRole(client: Client): Promise<void> {
  const who = await client.query<{ name: string; rolsuper: boolean }>(
    "SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname = current_user"
  );
  const role = who.rows[0];
  if (!role?.rolsuper) {
    throw new Error(`connected as ${role?.name ?? "unknown"}; run this as the migration role (postgres)`);
  }
  const fence = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'is_synthetic' AND table_name IN ('programs', 'users')`
  );
  if (fence.rows[0]?.n !== 2) {
    throw new Error("programs.is_synthetic or users.is_synthetic is missing; apply lib/db/sql/0019_synthetic_fence.sql first");
  }
}

function newPassword(): string {
  // 32 random bytes -> 43 base64url characters.
  return secret(randomBytes(32).toString("base64url"));
}

function newToken(): string {
  // One word, so keyword search matches it exactly: 24 characters.
  return secret(`zzcanary${randomBytes(8).toString("hex")}`);
}

/**
 * Programs and users in one transaction. In a dry run (`apply` false) the
 * transaction is READ ONLY and every change is only described. With --apply,
 * a user whose password cannot be kept fails the run; the users are read and
 * their passwords checked before anything is written, so such a run also
 * only describes the changes, writes nothing and says so. When it writes, the
 * per-program and per-user results are printed only after COMMIT. Under
 * --apply, any failure before COMMIT is sent (read phase, password problem,
 * failed query) reports that the transaction was rolled back and nothing was
 * changed in the database.
 */
async function provisionDatabase(client: Client, opts: Options, previous: Previous): Promise<DbResult | null> {
  // A READ ONLY transaction refuses row locks.
  const lock = opts.apply ? " FOR UPDATE" : "";
  let write = false;
  let commitSent = false;
  const pending: string[] = [];
  const problems: string[] = [];
  const created: Array<{ type: string; id: string | null; name: string }> = [];
  const changed: Array<{ type: string; id: string; fields: string[] }> = [];
  const revoked: Array<{ userId: string; sessions: number; mfaChallenges: number }> = [];
  const programIds: Partial<Record<ProgramKey, string>> = {};
  const userIds: Partial<Record<UserKey, string>> = {};
  const passwords: Partial<Record<UserKey, string>> = {};

  await client.query(opts.apply ? "BEGIN" : "BEGIN READ ONLY");
  try {
    // Users first: read each and check the password it must keep.
    const userRows: Partial<Record<UserKey, UserRow>> = {};
    const passwordProblem = new Set<UserKey>();
    for (const key of USER_KEYS) {
      const spec = USERS[key];
      const found = await client.query<UserRow>(
        `SELECT id::text, email, role::text, program_id::text, name, max_classification,
                must_reset_password, is_active, is_synthetic, password_hash
         FROM users WHERE lower(email) = lower($1)${lock}`,
        [spec.email]
      );
      const row = found.rows[0];
      if (!row) continue;
      if (!row.is_synthetic) {
        // users_synthetic_email_check makes this impossible; stop rather than touch a real account.
        throw new Error(`user ${spec.email} (${row.id}) exists and is not synthetic`);
      }
      userRows[key] = row;
      if (opts.rotatePasswords) continue;
      const kept = previous.passwords.get(spec.email);
      if (kept === undefined) {
        passwordProblem.add(key);
        problems.push(
          `user ${spec.email} exists but its password is not in ${opts.outFile}; rerun with --apply --rotate-passwords`
        );
      } else if (!(await verifyPassword(kept, row.password_hash))) {
        passwordProblem.add(key);
        problems.push(
          `the password for ${spec.email} in ${opts.outFile} does not match the stored hash; rerun with --apply --rotate-passwords`
        );
      } else {
        passwords[key] = kept;
      }
    }

    // A password problem fails the run, so nothing is written and every
    // change below is only described, also with --apply.
    write = opts.apply && problems.length === 0;
    // Results of a write are held until COMMIT succeeds; descriptions print now.
    const result = (line: string) => (write ? pending.push(line) : say(line));
    const verb = write ? "" : "would ";
    const notChanged = opts.apply && !write ? " (not changed: a password problem stops this run, see below)" : "";

    for (const key of ["a", "b"] as ProgramKey[]) {
      const name = PROGRAMS[key];
      const found = await client.query<ProgramRow>(
        `SELECT id::text, name, is_synthetic FROM programs WHERE lower(name) = lower($1)${lock}`,
        [name]
      );
      const row = found.rows[0];
      if (row && !row.is_synthetic) {
        throw new Error(`program "${row.name}" (${row.id}) exists and is not synthetic; rename it or pick another name`);
      }
      if (row) {
        programIds[key] = row.id;
        result(`program ${name}: exists (${row.id})`);
      } else if (write) {
        const inserted = await client.query<{ id: string }>(
          "INSERT INTO programs (name, is_synthetic) VALUES ($1, true) RETURNING id::text",
          [name]
        );
        programIds[key] = inserted.rows[0]!.id;
        created.push({ type: "program", id: programIds[key]!, name });
        result(`program ${name}: created (${programIds[key]})`);
      } else {
        result(`program ${name}: would create${notChanged}`);
      }
    }

    for (const key of USER_KEYS) {
      const spec = USERS[key];
      const programId = programIds[spec.program] ?? null;
      const row = userRows[key];
      if (!row) {
        const password = newPassword();
        passwords[key] = password;
        if (write) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO users (email, password_hash, role, program_id, name, is_active,
                                must_reset_password, max_classification, is_synthetic)
             VALUES ($1, $2, 'csr', $3::uuid, $4, true, false, 'internal', true)
             RETURNING id::text`,
            [spec.email, await hashPassword(password), programId, spec.name]
          );
          userIds[key] = inserted.rows[0]!.id;
          created.push({ type: "user", id: userIds[key]!, name: spec.email });
          result(`user ${spec.email}: created (${userIds[key]}) in ${PROGRAMS[spec.program]} with a new password`);
        } else {
          result(`user ${spec.email}: would create in ${PROGRAMS[spec.program]} with a new password${notChanged}`);
        }
        continue;
      }

      userIds[key] = row.id;
      const fields: string[] = [];
      if (row.role !== "csr") fields.push("role");
      if (programId === null || row.program_id !== programId) fields.push("program_id");
      if (row.name !== spec.name) fields.push("name");
      if (row.max_classification !== "internal") fields.push("max_classification");
      if (row.must_reset_password) fields.push("must_reset_password");
      if (!row.is_active) fields.push("is_active");

      // Kept passwords were checked above; a rotation sets a new one.
      let hash: string | null = null;
      if (opts.rotatePasswords) {
        passwords[key] = newPassword();
        fields.push("password_hash");
        if (write) hash = await hashPassword(passwords[key]!);
      }

      if (fields.length === 0) {
        result(
          passwordProblem.has(key)
            ? `user ${spec.email}: exists (${row.id}), no field to change, but its password cannot be kept (see below)`
            : `user ${spec.email}: exists (${row.id}), unchanged, password kept`
        );
        continue;
      }
      // A new password ends the user's sessions and pending MFA challenges in
      // the same transaction, as the admin password reset does
      // (routes/admin/users.ts: invalidateMfaChallenges, then DELETE FROM
      // sessions); session lookup never compares password hashes.
      let ended = "";
      if (write) {
        await client.query(
          `UPDATE users
           SET role = 'csr', program_id = $2::uuid, name = $3, max_classification = 'internal',
               must_reset_password = false, is_active = true,
               password_hash = COALESCE($4, password_hash)
           WHERE id = $1::uuid`,
          [row.id, programId, spec.name, hash]
        );
        changed.push({ type: "user", id: row.id, fields });
        if (hash !== null) {
          const challenges = await client.query(
            "DELETE FROM mfa_challenges WHERE user_id = $1::uuid AND consumed_at IS NULL",
            [row.id]
          );
          const sessions = await client.query("DELETE FROM sessions WHERE user_id = $1::uuid", [row.id]);
          revoked.push({ userId: row.id, sessions: sessions.rowCount ?? 0, mfaChallenges: challenges.rowCount ?? 0 });
          ended = `; ended ${sessions.rowCount ?? 0} session(s) and ${challenges.rowCount ?? 0} pending MFA challenge(s)`;
        }
      } else if (opts.rotatePasswords) {
        ended = "; would end its sessions and pending MFA challenges";
      }
      result(`user ${spec.email}: exists (${row.id}); ${verb}change ${fields.join(", ")}${ended}${notChanged}`);
    }

    if (problems.length > 0) {
      // With --apply, the catch below adds that the transaction was rolled back.
      throw new Error(problems.join("\n"));
    }

    if (!opts.apply) {
      await client.query("ROLLBACK");
      say("would append security event evidence.synthetic.provisioned");
      return null;
    }

    const event = await client.query<{ id: string }>(
      `SELECT id::text FROM append_security_event(
         'evidence.synthetic.provisioned', 'success', NULL, NULL, current_user::text, NULL,
         'synthetic_accounts', $1, NULL, NULL, $2::jsonb)`,
      [
        [...created, ...changed].map((r) => r.id).join(",") || null,
        JSON.stringify({
          script: SCRIPT,
          created,
          changed,
          passwordsRotated: opts.rotatePasswords,
          sessionsEnded: revoked,
          programs: [programIds.a, programIds.b],
          users: [userIds.csrA, userIds.csrB]
        })
      ]
    );
    commitSent = true;
    await client.query("COMMIT");
    say("transaction committed");
    for (const line of pending) say(line);
    say(`security event evidence.synthetic.provisioned appended (${event.rows[0]?.id ?? "?"})`);
    return {
      programIds: programIds as Record<ProgramKey, string>,
      userIds: userIds as Record<UserKey, string>,
      passwords: passwords as Record<UserKey, string>
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // A dry run's READ ONLY transaction could not change anything.
    if (!opts.apply) throw error;
    // Under --apply every failure before COMMIT was sent, including one in the
    // read phase before any write, leaves nothing changed: Postgres discards an
    // uncommitted transaction on ROLLBACK or when the connection drops. A
    // server error (it carries a severity) means Postgres rolled the
    // transaction back, also when COMMIT itself was refused. A connection lost
    // after COMMIT was sent leaves the outcome unknown.
    const serverAnswered = error instanceof Error && typeof (error as { severity?: unknown }).severity === "string";
    if (commitSent && !serverAnswered) {
      throw new Error(
        `${errorMessage(error)}\nthe connection failed during COMMIT, so it is unknown whether the transaction ` +
          "was saved; run the dry run to see the database state"
      );
    }
    throw new Error(`${errorMessage(error)}\nthe transaction was rolled back; nothing was changed in the database`);
  }
}

// ------------------------------------------------------------------- API

interface DocItem { documentId: string; title: string; lifecycleState: string; classification: string }
interface DocList { items: DocItem[]; sources: Array<{ id: string }> }

class Api {
  private cookie: string | null = null;
  constructor(private readonly baseUrl: string) {}

  private async request(
    method: "GET" | "POST",
    pathname: string,
    init: { programId?: string; json?: unknown; form?: FormData } = {}
  ): Promise<{ status: number; body: unknown; setCookie: string | null }> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
    if (method !== "GET") headers.origin = this.baseUrl;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (this.cookie) headers.cookie = `${SESSION_COOKIE}=${this.cookie}`;
    if (init.programId) headers["x-program-id"] = init.programId;
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers,
      body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const raw = await response.text();
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const prefix = `${SESSION_COOKIE}=`;
    const setCookie =
      response.headers
        .getSetCookie()
        .map((h) => h.split(";")[0]?.trim() ?? "")
        .find((pair) => pair.startsWith(prefix) && pair.length > prefix.length)
        ?.slice(prefix.length) ?? null;
    return { status: response.status, body, setCookie };
  }

  private static errorText(body: unknown): string {
    const e = body && typeof body === "object" ? (body as Record<string, unknown>).error : undefined;
    return typeof e === "string" ? `: ${e.slice(0, 200)}` : "";
  }

  async login(agent: { email: string; password: string }): Promise<void> {
    const r = await this.request("POST", "/api/auth/login", { json: { email: agent.email, password: agent.password } });
    if (r.status !== 200 || !r.setCookie) {
      throw new Error(`agent login failed with HTTP ${r.status}${Api.errorText(r.body)}`);
    }
    this.cookie = secret(r.setCookie);
  }

  get loggedIn(): boolean {
    return this.cookie !== null;
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    try {
      const r = await this.request("POST", "/api/auth/logout");
      say(r.status < 300 ? "agent logged out" : `agent logout answered HTTP ${r.status}`);
    } finally {
      this.cookie = null;
    }
  }

  async documents(programId: string): Promise<DocList> {
    const r = await this.request("GET", "/api/documents", { programId });
    const body = (r.body ?? {}) as Partial<DocList>;
    if (r.status !== 200 || !Array.isArray(body.items) || !Array.isArray(body.sources)) {
      throw new Error(`GET /api/documents for program ${programId} answered HTTP ${r.status}${Api.errorText(r.body)}`);
    }
    return { items: body.items, sources: body.sources };
  }

  async upload(programId: string, fields: { file: string; content: string; title: string; sourceId: string; classification: string }): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([fields.content], { type: "text/markdown" }), fields.file);
    form.append("title", fields.title);
    form.append("sourceId", fields.sourceId);
    form.append("classification", fields.classification);
    const r = await this.request("POST", "/api/documents/upload", { programId, form });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`upload of "${fields.title}" answered HTTP ${r.status}${Api.errorText(r.body)}`);
    }
  }
}

function canaryContent(title: string, token: string): string {
  return [
    `# ${title}`,
    "",
    "This is a synthetic canary document for the Truenote evidence harness. It contains no customer data.",
    "The harness asks about the code below to prove that program isolation and classification limits hold.",
    "",
    `The synthetic canary code is ${token}.`,
    ""
  ].join("\n");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Canary tokens from the output file, or new ones; all distinct. */
function canaryTokens(opts: Options, previous: Previous): Record<CanaryKey, string> {
  const tokens = {} as Record<CanaryKey, string>;
  for (const key of CANARY_KEYS) tokens[key] = previous.canaries[key]?.token ?? newToken();
  if (new Set(Object.values(tokens).map((t) => t.toLowerCase())).size !== CANARY_KEYS.length) {
    throw new Error(`the canary tokens in ${opts.outFile} are not distinct; remove the canaries from the file and rerun`);
  }
  return tokens;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function provisionCanaries(
  opts: Options,
  agent: { email: string; password: string },
  programIds: Record<ProgramKey, string>,
  previous: Previous,
  tokens: Record<CanaryKey, string>
): Promise<Record<CanaryKey, { documentId: string; token: string }>> {
  const api = new Api(opts.baseUrl);
  const result = {} as Record<CanaryKey, { documentId: string; token: string }>;
  try {
    await api.login(agent);
    say("agent logged in");
    const pending: CanaryKey[] = [];
    for (const key of CANARY_KEYS) {
      const spec = CANARIES[key];
      const programId = programIds[spec.program];
      const list = await api.documents(programId);
      const item = list.items.find((i) => i.title === spec.title);
      const known = previous.canaries[key];
      if (
        item &&
        item.lifecycleState === "active" &&
        item.classification === spec.classification &&
        known?.documentId === item.documentId
      ) {
        result[key] = { documentId: item.documentId, token: tokens[key] };
        say(`canary ${key}: "${spec.title}" active (${item.documentId}), reused`);
        continue;
      }
      const sourceId = list.sources[0]?.id;
      if (!sourceId) throw new Error(`program ${PROGRAMS[spec.program]} has no approved content source to upload into`);
      await api.upload(programId, {
        file: spec.file,
        content: canaryContent(spec.title, tokens[key]),
        title: spec.title,
        sourceId,
        classification: spec.classification
      });
      say(
        `canary ${key}: uploaded "${spec.title}" (${spec.classification}) to ${PROGRAMS[spec.program]}` +
          (item ? ` as a new version of ${item.documentId} (was ${item.lifecycleState}, ${item.classification})` : "")
      );
      pending.push(key);
    }

    const deadline = Date.now() + INGESTION_TIMEOUT_MS;
    while (pending.length > 0) {
      await sleep(opts.pollMs);
      for (const key of [...pending]) {
        const spec = CANARIES[key];
        const list = await api.documents(programIds[spec.program]);
        const item = list.items.find((i) => i.title === spec.title);
        const state = item?.lifecycleState ?? "not listed";
        if (item && state === "active" && item.classification === spec.classification) {
          result[key] = { documentId: item.documentId, token: tokens[key] };
          pending.splice(pending.indexOf(key), 1);
          say(`canary ${key}: "${spec.title}" active (${item.documentId})`);
        } else if (FAILED_STATES.has(state)) {
          throw new Error(`canary ${key}: "${spec.title}" ended in lifecycle state ${state}`);
        } else if (Date.now() > deadline) {
          throw new Error(
            `canary ${key}: "${spec.title}" was not active after ${INGESTION_TIMEOUT_MS / 60_000} minutes; lifecycle state ${state}`
          );
        }
      }
    }
  } catch (error) {
    // Log out, but report the upload or ingestion error: a logout failure
    // here is only mentioned, never thrown in its place.
    if (api.loggedIn) {
      await api.logout().catch((logoutError: unknown) => {
        console.error(redact(`${LOG} agent logout after the failure below also failed: ${errorMessage(logoutError)}`));
      });
    }
    throw error;
  }
  // Every canary is active. A failed logout must not stop main() from
  // writing the output file, so it is reported and the run still succeeds.
  if (api.loggedIn) {
    await api.logout().catch((logoutError: unknown) => {
      console.error(
        redact(
          `${LOG} agent logout failed: ${errorMessage(logoutError)}; the canaries are in place and the output ` +
            "file is still written. The agent session may stay open until it expires."
        )
      );
    });
  }
  return result;
}

// ---------------------------------------------------------------- output

/**
 * Saved right after the database commit, before any API call, so a failed
 * canary step cannot lose the committed passwords: the next --apply reads
 * them back through readPrevious(). Canaries not yet confirmed active carry
 * their token and the document id the previous file had, if any. Not yet
 * valid for EVIDENCE_SYNTHETIC_ACCOUNTS; writeOutput() completes it.
 */
async function writePartialOutput(
  file: string,
  db: DbResult,
  tokens: Record<CanaryKey, string>,
  previous: Previous
): Promise<void> {
  const canary = (key: CanaryKey) => {
    const known = previous.canaries[key];
    return { documentId: known?.token === tokens[key] ? known.documentId : null, token: tokens[key] };
  };
  await writeJson(file, {
    csrA: { email: USERS.csrA.email, password: db.passwords.csrA },
    csrB: { email: USERS.csrB.email, password: db.passwords.csrB },
    canaries: { a: canary("a"), b: canary("b"), aConfidential: canary("aConfidential") }
  });
}

async function writeOutput(
  file: string,
  db: DbResult,
  canaries: Record<CanaryKey, { documentId: string; token: string }>
): Promise<void> {
  await writeJson(file, {
    csrA: { email: USERS.csrA.email, password: db.passwords.csrA },
    csrB: { email: USERS.csrB.email, password: db.passwords.csrB },
    canaries: { a: canaries.a, b: canaries.b, aConfidential: canaries.aConfidential }
  });
}

/** Atomic write, owner-only permissions. */
async function writeJson(file: string, body: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  // Windows ignores most mode bits; the folder's ACL applies there.
  await chmod(file, 0o600).catch(() => undefined);
}

// ------------------------------------------------------------------ main

async function main(): Promise<void> {
  const opts = readOptions(process.argv.slice(2));
  if (opts.rotatePasswords && !opts.apply) say("dry run: --rotate-passwords only takes effect with --apply");
  say(opts.apply ? "applying" : "dry run: nothing is written; add --apply to provision");
  const agent = await readAgent(opts.agentFile);
  const previous = await readPrevious(opts.outFile);
  // Checked before the transaction, so a bad file stops the run before it commits.
  const tokens = canaryTokens(opts, previous);

  // A closed SSH tunnel fails here after 30 s instead of hanging.
  const client = new Client({ connectionString: opts.databaseUrl, connectionTimeoutMillis: 30_000 });
  // A connection-level error otherwise crashes the process with a stack
  // trace; the pending query rejects with it and main() reports the message.
  client.on("error", () => undefined);
  let db: DbResult | null;
  try {
    await client.connect();
    await checkRole(client);
    db = await provisionDatabase(client, opts, previous);
  } finally {
    await client.end().catch(() => undefined);
  }

  if (!opts.apply || db === null) {
    for (const key of CANARY_KEYS) {
      const spec = CANARIES[key];
      const known = previous.canaries[key];
      say(
        `canary ${key}: would log in to ${opts.baseUrl} as the agent and reuse "${spec.title}" if it is active ` +
          `(${spec.classification})${known?.documentId ? ` with id ${known.documentId}` : ""}, else upload it ` +
          `with ${known ? "the token from the output file" : "a new token"} and wait for ingestion`
      );
    }
    say(`would write ${opts.outFile}`);
    say("dry run complete: nothing was written");
    return;
  }

  await writePartialOutput(opts.outFile, db, tokens, previous);
  say(`passwords saved to ${opts.outFile}; a failed canary step can be resumed with --apply`);
  const canaries = await provisionCanaries(opts, agent, db.programIds, previous, tokens);
  await writeOutput(opts.outFile, db, canaries);

  say("done");
  say(`  programs: ${PROGRAMS.a}=${db.programIds.a} ${PROGRAMS.b}=${db.programIds.b}`);
  say(`  users: ${USERS.csrA.email}=${db.userIds.csrA} ${USERS.csrB.email}=${db.userIds.csrB}`);
  for (const key of CANARY_KEYS) say(`  canary ${key}: documentId ${canaries[key].documentId}`);
  say(`  output: ${opts.outFile} (passwords and tokens; set it as EVIDENCE_SYNTHETIC_ACCOUNTS)`);
}

try {
  await main();
} catch (error) {
  // Only the message: pg errors carry row details and fetch errors the URL's
  // context; redact() strips every secret this run has seen.
  const message = error instanceof Error ? error.message : String(error);
  console.error(redact(`${LOG} failed: ${message}`));
  process.exitCode = 1;
}
