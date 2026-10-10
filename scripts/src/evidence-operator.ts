/**
 * The monthly operator check of the evidence harness
 * (docs/security/evidence-harness.md, "Operator check and export (phase 3)";
 * catalog entry operator.monthly-verification).
 *
 * The application role cannot show that the append-only triggers also refuse
 * the owner, and cannot run the PCI catalog verifier as the owner. Once a
 * month the owner runs this script from their own machine, through an SSH
 * tunnel to `pgvector`, as the migration role:
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5434/railway \
 *     pnpm --filter @workspace/scripts run evidence:operator
 *   ... evidence:operator -- --apply
 *   ... evidence:operator -- --apply --export-dir ~/truenote-evidence [--month 2026-09] [--push]
 *
 * Steps, all over one database connection:
 *
 * 1. Refuse to run unless session_user is a superuser or a member of the
 *    owner of evidence_receipts.
 * 2. Verifier: set truenote.evidence_runtime_role (default truenote_app,
 *    --runtime-role overrides) and run
 *    docs/compliance/pci/production-control-verification.sql as a whole. It
 *    opens and commits its own READ ONLY transaction. The controls that
 *    failed and the sha256 of each object definition are recorded, not the
 *    definitions themselves.
 * 3. Negative tests: in one transaction that always ends in ROLLBACK, an
 *    UPDATE and a DELETE aimed at the newest row and a TRUNCATE, each in its
 *    own savepoint, on evidence_receipts and on security_events. Each must
 *    raise an error. A lock or statement timeout is not a refusal and stops
 *    the run. After the rollback, the rows that existed before the tests must
 *    be unchanged (their count and the newest one's hash); rows appended by
 *    the application in the meantime are allowed and reported.
 * 4. Receipt: result pass only when every verifier control passed and all six
 *    tests were refused. Appended with append_evidence_receipt only under
 *    --apply; a dry run prints the payload and appends nothing.
 * 5. Export (--export-dir, with or without --apply; reads the database only):
 *    the receipts recorded in the UTC month (--month YYYY-MM, default the
 *    previous month), the attachments they name and the chain head, written
 *    to <dir>/<YYYY-MM>/ after the chain from the month's first receipt to
 *    the head recomputes. A mismatch writes nothing. When <dir> is the top
 *    level of a Git repository, the month folder is committed; --push pushes.
 *
 * Exits non-zero on any error. Never prints DATABASE_URL or its password.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { getCheck } from "../../artifacts/api-server/src/lib/evidence/catalog.js";
import { canonicalJson, receiptHash, sha256Hex } from "../../artifacts/api-server/src/lib/evidence/canonical.js";
import { buildReceiptPayload, type CheckOutcome } from "../../artifacts/api-server/src/lib/evidence/receipts.js";
import { closePool } from "../../artifacts/api-server/src/lib/db-client.js";

const LOG = "[evidence-operator]";
const CHECK_ID = "operator.monthly-verification";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERIFIER_FILE = "docs/compliance/pci/production-control-verification.sql";
const TABLES = [
  { table: "evidence_receipts", hashColumn: "receipt_hash", noopColumn: "result" },
  { table: "security_events", hashColumn: "event_hash", noopColumn: "outcome" }
] as const;
// 55P03 lock_not_available, 57014 query_canceled: the statement never reached the trigger.
const TIMEOUT_CODES = new Set(["55P03", "57014"]);
const run = promisify(execFile);

// ------------------------------------------------------------- redaction

const secrets = new Set<string>();
function redact(line: string): string {
  let out = line;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out;
}
function say(line: string): void {
  console.log(redact(`${LOG} ${line}`));
}

// ---------------------------------------------------------------- options

interface Options {
  apply: boolean;
  push: boolean;
  exportDir: string | null;
  month: string;
  runtimeRole: string;
  databaseUrl: string;
}

const USAGE =
  "usage: evidence-operator [--apply] [--runtime-role <role>] [--export-dir <path> [--month YYYY-MM] [--push]]";

function previousUtcMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? path.join(homedir(), p.slice(1)) : p;
}

function readOptions(argv: string[]): Options {
  let apply = false;
  let push = false;
  let exportDir: string | null = null;
  let month: string | null = null;
  let runtimeRole = "truenote_app";
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value; ${USAGE}`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") continue;
    if (arg === "--apply") apply = true;
    else if (arg === "--push") push = true;
    else if (arg === "--export-dir") exportDir = value(++i, arg);
    else if (arg === "--month") month = value(++i, arg);
    else if (arg === "--runtime-role") runtimeRole = value(++i, arg);
    else throw new Error(`unknown argument ${arg}; ${USAGE}`);
  }
  if (!exportDir && (month !== null || push)) throw new Error(`--month and --push need --export-dir; ${USAGE}`);
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("--month must be YYYY-MM");
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(runtimeRole)) throw new Error("--runtime-role must be a plain role name");
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  if (!databaseUrl) throw new Error("DATABASE_URL is not set; point it at the migration role through the SSH tunnel");
  secrets.add(databaseUrl);
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    if (password) secrets.add(password);
  } catch {
    // Not a URL; pg reports the problem when it connects.
  }
  return {
    apply,
    push,
    exportDir: exportDir ? path.resolve(expandHome(exportDir)) : null,
    month: month ?? previousUtcMonth(),
    runtimeRole,
    databaseUrl
  };
}

// ---------------------------------------------------------------- role

async function checkRole(client: Client): Promise<{ sessionUser: string; owner: string; superuser: boolean }> {
  const res = await client.query<{ session_user: string; superuser: boolean | null; owner: string | null; member: boolean | null }>(
    `SELECT session_user::text AS session_user,
            (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = session_user) AS superuser,
            pg_get_userbyid(c.relowner)::text AS owner,
            pg_has_role(session_user, c.relowner, 'MEMBER') AS member
     FROM (SELECT 1) AS one
     LEFT JOIN pg_class c ON c.oid = to_regclass('public.evidence_receipts')`
  );
  const row = res.rows[0];
  if (!row || row.owner === null) throw new Error("public.evidence_receipts does not exist; apply 0012 and 0020 first");
  if (!row.superuser && !row.member) {
    throw new Error(
      `connected as ${row.session_user}, which is neither a superuser nor a member of ${row.owner}, ` +
        "the owner of evidence_receipts; run this as the migration role"
    );
  }
  return { sessionUser: row.session_user, owner: row.owner, superuser: row.superuser === true };
}

// ---------------------------------------------------------------- verifier

interface VerifierResult {
  file: string;
  /** sha256 of the verifier text with CRLF line ends turned into LF, as Git stores it. */
  fileSha256: string;
  runtimeRole: string;
  controlsChecked: number;
  controlsPassed: number;
  failedControls: Array<{ category: string; control: string; observed: string }>;
  definitions: Array<{ objectType: string; objectName: string; sha256: string }>;
}

async function runVerifier(client: Client, runtimeRole: string): Promise<VerifierResult> {
  const text = await readFile(path.join(REPO_ROOT, VERIFIER_FILE), "utf8");
  await client.query("SELECT set_config('truenote.evidence_runtime_role', $1, false)", [runtimeRole]);
  let results: Array<{ fields: Array<{ name: string }>; rows: Array<Record<string, unknown>> }>;
  try {
    // No parameters: the simple query protocol runs the file's statements in order.
    const raw = (await client.query(text)) as unknown;
    results = (Array.isArray(raw) ? raw : [raw]) as typeof results;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new Error(`the verifier failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const has = (r: (typeof results)[number], name: string) => r.fields?.some((f) => f.name === name) ?? false;
  const controls = results.find((r) => has(r, "passed") && has(r, "control"));
  const definitions = results.find((r) => has(r, "definition_sha256"));
  if (!controls || !definitions) throw new Error("the verifier did not return its controls and definitions result sets");
  const failedControls = controls.rows
    .filter((r) => r.passed !== true)
    .map((r) => ({ category: String(r.category), control: String(r.control), observed: String(r.observed) }));
  return {
    file: VERIFIER_FILE,
    fileSha256: sha256Hex(text.replace(/\r\n/g, "\n")),
    runtimeRole,
    controlsChecked: controls.rows.length,
    controlsPassed: controls.rows.length - failedControls.length,
    failedControls,
    definitions: definitions.rows.map((r) => ({
      objectType: String(r.object_type),
      objectName: String(r.object_name),
      sha256: String(r.definition_sha256)
    }))
  };
}

// ---------------------------------------------------------------- negative tests

interface Head {
  count: number;
  sequence: number | null;
  hash: string | null;
}

interface NegativeTest {
  table: string;
  statement: string;
  refused: boolean;
  error: string | null;
  sqlstate?: string;
  reason?: string;
}

async function readHead(client: Client, table: string, hashColumn: string): Promise<Head> {
  // Table and column names come from the fixed TABLES list above.
  const res = await client.query<{ n: string; seq: string | null; h: string | null }>(
    `SELECT (SELECT count(*) FROM ${table})::text AS n,
            newest.sequence::text AS seq, newest.${hashColumn} AS h
     FROM (SELECT 1) AS one
     LEFT JOIN (SELECT sequence, ${hashColumn} FROM ${table} ORDER BY sequence DESC LIMIT 1) AS newest ON true`
  );
  const row = res.rows[0]!;
  return { count: Number(row.n), sequence: row.seq === null ? null : Number(row.seq), hash: row.h };
}

async function runNegativeTests(
  client: Client
): Promise<{ tests: NegativeTest[]; heads: Record<string, Head>; appendedMeanwhile: Record<string, number> }> {
  const heads: Record<string, Head> = {};
  const tests: NegativeTest[] = [];
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    for (const t of TABLES) heads[t.table] = await readHead(client, t.table, t.hashColumn);
    for (const t of TABLES) {
      const head = heads[t.table]!;
      const statements = [
        head.sequence === null ? null : `UPDATE ${t.table} SET ${t.noopColumn} = ${t.noopColumn} WHERE sequence = ${head.sequence}`,
        head.sequence === null ? null : `DELETE FROM ${t.table} WHERE sequence = ${head.sequence}`,
        `TRUNCATE ${t.table}`
      ];
      const labels = ["UPDATE", "DELETE", "TRUNCATE"];
      for (let i = 0; i < statements.length; i++) {
        const statement = statements[i];
        if (statement === null || statement === undefined) {
          tests.push({
            table: t.table,
            statement: `${labels[i]} ${t.table} (newest row)`,
            refused: false,
            error: null,
            reason: "the table is empty, so there is no row to aim at; not tested"
          });
          continue;
        }
        await client.query("SAVEPOINT negative_test");
        try {
          await client.query(statement);
          tests.push({ table: t.table, statement, refused: false, error: null });
        } catch (error) {
          const err = error as { message?: string; code?: string };
          if (err.code && TIMEOUT_CODES.has(err.code)) {
            throw new Error(`${statement} timed out (${err.code}) before reaching the trigger; nothing was tested, rerun later`);
          }
          tests.push({ table: t.table, statement, refused: true, error: err.message ?? String(error), sqlstate: err.code });
        }
        // Undo the statement whether or not it ran, and release its locks.
        await client.query("ROLLBACK TO SAVEPOINT negative_test");
      }
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
  }

  // The rows that existed before the tests must be exactly there; the
  // application may have appended new ones meanwhile.
  const appendedMeanwhile: Record<string, number> = {};
  for (const t of TABLES) {
    const before = heads[t.table]!;
    const res = await client.query<{ n: string; h: string | null; total: string }>(
      `SELECT (SELECT count(*) FROM ${t.table} WHERE sequence <= $1)::text AS n,
              (SELECT ${t.hashColumn} FROM ${t.table} WHERE sequence = $1) AS h,
              (SELECT count(*) FROM ${t.table})::text AS total`,
      [before.sequence ?? 0]
    );
    const row = res.rows[0]!;
    if (Number(row.n) !== before.count || (before.sequence !== null && row.h !== before.hash)) {
      throw new Error(
        `${t.table} changed during the negative tests (count ${before.count} -> ${row.n}, newest hash ` +
          `${before.hash ?? "none"} -> ${row.h ?? "none"}); the rollback did not hold, investigate before anything else`
      );
    }
    appendedMeanwhile[t.table] = Number(row.total) - before.count;
  }
  return { tests, heads, appendedMeanwhile };
}

// ---------------------------------------------------------------- export

interface ReceiptRow {
  sequence: string;
  id: string;
  recorded_at_text: string;
  check_id: string;
  check_kind: string;
  result: string;
  payload: string;
  payload_sha256: string;
  previous_hash: string | null;
  receipt_hash: string;
}

const RECEIPT_COLUMNS =
  "sequence::text AS sequence, id::text AS id, recorded_at_text, check_id, check_kind, result, payload, " +
  "payload_sha256, previous_hash, receipt_hash";

function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return {
    start: new Date(Date.UTC(y, m - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, m, 1)).toISOString()
  };
}

/** Recomputes payload_sha256, receipt_hash and each link; returns the first bad sequence's message or null. */
function verifyChain(rows: ReceiptRow[], previousHash: string | null): string | null {
  let expected = previousHash;
  for (const r of rows) {
    if (sha256Hex(r.payload) !== r.payload_sha256) {
      return `sequence ${r.sequence}: payload_sha256 does not match sha256(payload)`;
    }
    if ((r.previous_hash ?? null) !== expected) {
      return `sequence ${r.sequence}: previous_hash does not match the prior receipt's receipt_hash`;
    }
    if (receiptHash(r.previous_hash, r.id, r.recorded_at_text, r.payload) !== r.receipt_hash) {
      return `sequence ${r.sequence}: receipt_hash does not recompute`;
    }
    expected = r.receipt_hash;
  }
  return null;
}

interface AttachmentEntry {
  receiptId: string;
  key: string;
  sha256: string;
  bytes: number;
  contentType: string;
}

function attachmentsOf(r: ReceiptRow): AttachmentEntry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(r.payload);
  } catch {
    throw new Error(`sequence ${r.sequence}: the payload is not JSON`);
  }
  const list = (doc as { attachments?: unknown }).attachments;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`sequence ${r.sequence}: payload attachments is not a list`);
  return list.map((a, i) => {
    const x = a as Record<string, unknown>;
    if (
      typeof x.key !== "string" ||
      typeof x.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(x.sha256) ||
      typeof x.bytes !== "number" ||
      typeof x.contentType !== "string"
    ) {
      throw new Error(`sequence ${r.sequence}: attachment ${i} lacks key, sha256, bytes or contentType`);
    }
    return { receiptId: r.id, key: x.key, sha256: x.sha256, bytes: x.bytes, contentType: x.contentType };
  });
}

async function git(dir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run("git", ["-C", dir, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number | string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: typeof e.code === "number" ? e.code : -1 };
  }
}

async function exportMonth(client: Client, opts: Options & { exportDir: string }): Promise<void> {
  const info = await stat(opts.exportDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`--export-dir ${opts.exportDir} is not an existing directory`);

  const { start, end } = monthBounds(opts.month);
  const monthRows = (
    await client.query<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM evidence_receipts
       WHERE recorded_at >= $1::timestamptz AND recorded_at < $2::timestamptz ORDER BY sequence`,
      [start, end]
    )
  ).rows;
  const headRow = (await client.query<ReceiptRow>(`SELECT ${RECEIPT_COLUMNS} FROM evidence_receipts ORDER BY sequence DESC LIMIT 1`)).rows[0];

  // Verify from the month's first receipt to the chain head, linked to the receipt before the month.
  if (monthRows.length > 0) {
    const first = monthRows[0]!;
    const last = monthRows[monthRows.length - 1]!;
    const prior = (
      await client.query<{ receipt_hash: string }>(
        "SELECT receipt_hash FROM evidence_receipts WHERE sequence < $1::bigint ORDER BY sequence DESC LIMIT 1",
        [first.sequence]
      )
    ).rows[0];
    const later = (
      await client.query<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM evidence_receipts WHERE sequence > $1::bigint ORDER BY sequence`,
        [last.sequence]
      )
    ).rows;
    const bad = verifyChain([...monthRows, ...later], prior?.receipt_hash ?? null);
    if (bad) throw new Error(`the evidence chain does not verify at ${bad}; nothing was exported`);
  }
  const attachments = monthRows.flatMap(attachmentsOf);

  const monthDir = path.join(opts.exportDir, opts.month);
  const lines = monthRows.map((r) =>
    JSON.stringify({
      sequence: Number(r.sequence),
      id: r.id,
      recorded_at_text: r.recorded_at_text,
      check_id: r.check_id,
      check_kind: r.check_kind,
      result: r.result,
      payload: r.payload,
      payload_sha256: r.payload_sha256,
      previous_hash: r.previous_hash,
      receipt_hash: r.receipt_hash
    })
  );
  const head = {
    month: opts.month,
    sequence: headRow ? Number(headRow.sequence) : null,
    receiptHash: headRow?.receipt_hash ?? null,
    recordedAt: headRow?.recorded_at_text ?? null,
    exported: monthRows.length
  };
  await mkdir(monthDir, { recursive: true });
  await writeFile(path.join(monthDir, "receipts.jsonl"), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  await writeFile(path.join(monthDir, "attachments.json"), `${JSON.stringify(attachments, null, 2)}\n`, "utf8");
  await writeFile(path.join(monthDir, "chain-head.json"), `${JSON.stringify(head, null, 2)}\n`, "utf8");
  say(`export: ${monthRows.length} receipts and ${attachments.length} attachments of ${opts.month} written to ${monthDir}`);
  say(`export: chain head sequence ${head.sequence ?? "none"}, receipt_hash ${head.receiptHash ?? "none"}`);

  const inside = await git(opts.exportDir, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    if (opts.push) throw new Error(`--push given but ${opts.exportDir} is not a Git repository`);
    say("export: the directory is not a Git repository; nothing committed");
    return;
  }
  const prefix = await git(opts.exportDir, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok || prefix.stdout.trim() !== "") {
    throw new Error(`${opts.exportDir} is inside a Git repository but not its top level; files written, nothing committed`);
  }
  const add = await git(opts.exportDir, ["add", "--", opts.month]);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const staged = await git(opts.exportDir, ["diff", "--cached", "--quiet", "--", opts.month]);
  if (staged.ok) {
    say(`export: ${opts.month} is already committed with this content; no new commit`);
  } else {
    const commit = await git(opts.exportDir, [
      "commit",
      "-m",
      `Evidence export for ${opts.month}`,
      "-m",
      `${monthRows.length} receipts recorded in ${opts.month} (UTC). Chain head at export: sequence ` +
        `${head.sequence ?? "none"}, receipt_hash ${head.receiptHash ?? "none"}.`,
      "--",
      opts.month
    ]);
    if (!commit.ok) throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim()}`);
    say(`export: committed ${opts.month}`);
  }
  if (opts.push) {
    const push = await git(opts.exportDir, ["push"]);
    if (!push.ok) throw new Error(`git push failed: ${push.stderr.trim()}`);
    say("export: push to the remote finished");
  } else {
    say("export: no --push, the commit stays local");
  }
}

// ---------------------------------------------------------------- main

async function scriptCommit(): Promise<string | null> {
  const head = await git(REPO_ROOT, ["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  const dirty = await git(REPO_ROOT, ["status", "--porcelain", "--", "scripts", "artifacts/api-server/src/lib/evidence", VERIFIER_FILE]);
  return `${head.stdout.trim()}${dirty.ok && dirty.stdout.trim() ? "+dirty" : ""}`;
}

async function main(): Promise<void> {
  const opts = readOptions(process.argv.slice(2));
  const check = getCheck(CHECK_ID);
  if (!check || check.kind !== "operator") throw new Error(`${CHECK_ID} of kind operator is missing from the catalog`);

  const client = new Client({ connectionString: opts.databaseUrl });
  client.on("error", (error) => say(`database connection error: ${error.message}`));
  await client.connect();
  try {
    const role = await checkRole(client);
    say(`${opts.apply ? "apply" : "dry run"}: connected as ${role.sessionUser} (${role.superuser ? "superuser" : `member of ${role.owner}`})`);

    const startedAt = new Date();
    const verifier = await runVerifier(client, opts.runtimeRole);
    say(
      `verifier: ${verifier.controlsPassed} of ${verifier.controlsChecked} controls passed, ` +
        `${verifier.definitions.length} definitions hashed (runtime role ${opts.runtimeRole})`
    );
    for (const f of verifier.failedControls) say(`  failed control: ${f.category} ${f.control} (${f.observed})`);

    const negative = await runNegativeTests(client);
    const finishedAt = new Date();
    const refusedCount = negative.tests.filter((t) => t.refused).length;
    say(`negative tests: ${refusedCount} of ${negative.tests.length} refused, all rolled back`);
    for (const t of negative.tests) {
      say(`  ${t.refused ? "refused    " : "NOT refused"} ${t.statement}${t.error ? ` -> ${t.error}` : ""}${t.reason ? ` (${t.reason})` : ""}`);
    }
    for (const [table, n] of Object.entries(negative.appendedMeanwhile)) {
      if (n > 0) say(`  note: ${n} ${table} rows were appended by others during the tests; the earlier rows are unchanged`);
    }

    const verifierPassed = verifier.controlsChecked > 0 && verifier.failedControls.length === 0;
    const testsPassed = negative.tests.length === 6 && refusedCount === 6;
    const failures = [
      ...(verifier.controlsChecked === 0 ? ["verifier returned no controls"] : []),
      ...verifier.failedControls.map((f) => `verifier: ${f.category} ${f.control} failed (${f.observed})`),
      ...negative.tests
        .filter((t) => !t.refused)
        .map((t) => `not refused: ${t.statement}${t.reason ? ` (${t.reason})` : ""}`)
    ];
    const outcome: CheckOutcome = {
      result: verifierPassed && testsPassed ? "pass" : "fail",
      summary:
        `Verifier: ${verifier.controlsPassed} of ${verifier.controlsChecked} controls passed. ` +
        `Negative tests as ${role.sessionUser}: ${refusedCount} of ${negative.tests.length} refused.`,
      failures,
      inputs: {
        runtimeRole: opts.runtimeRole,
        verifierFile: verifier.file,
        verifierSha256: verifier.fileSha256,
        scriptCommit: await scriptCommit()
      },
      outputs: {
        verifier: {
          controlsChecked: verifier.controlsChecked,
          controlsPassed: verifier.controlsPassed,
          failedControls: verifier.failedControls,
          definitions: verifier.definitions
        },
        negativeTests: negative.tests,
        sessionUser: role.sessionUser,
        chainHeads: {
          evidenceReceipts: negative.heads.evidence_receipts,
          securityEvents: negative.heads.security_events
        }
      }
    };
    const payload = buildReceiptPayload(check, outcome, { runId: null, startedAt, finishedAt });
    const text = canonicalJson(payload);
    say(`result: ${outcome.result}`);

    if (opts.apply) {
      const res = await client.query<{ id: string; sequence: string; recorded_at: string; receipt_hash: string }>(
        "SELECT id::text AS id, sequence::text AS sequence, recorded_at, receipt_hash FROM append_evidence_receipt($1)",
        [text]
      );
      const row = res.rows[0];
      if (!row) throw new Error("append_evidence_receipt returned no row");
      say(`appended operator receipt ${row.id}: sequence ${row.sequence}, recorded ${row.recorded_at}, receipt_hash ${row.receipt_hash}`);
    } else {
      say(`dry run: would append this ${CHECK_ID} receipt (${Buffer.byteLength(text)} bytes):`);
      console.log(redact(JSON.stringify(payload, null, 2)));
      say("dry run: no receipt appended; rerun with --apply to append it");
    }

    if (opts.exportDir) await exportMonth(client, { ...opts, exportDir: opts.exportDir });
  } finally {
    await client.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  // Only the message; redact() strips DATABASE_URL and its password.
  const message = error instanceof Error ? error.message : String(error);
  console.error(redact(`${LOG} failed: ${message}`));
  process.exitCode = 1;
} finally {
  // receipts.ts imports the shared db client; its pool never connects here.
  await closePool().catch(() => undefined);
}
