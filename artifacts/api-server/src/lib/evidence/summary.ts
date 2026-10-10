import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { getEmailSender } from "../email/sender.js";
import { escapeHtml } from "../email/templates.js";
import { withDeadline } from "../monitoring/alert-email.js";
import { recordAppError } from "../observability/error-log.js";
import { dueAttestations } from "./attestations.js";
import { ASSESSMENT_STATEMENT, EVIDENCE_CHECKS, type CheckDefinition } from "./catalog.js";
import { evidenceAlertRecipients } from "./notify.js";
import { appendReceipt, buildReceiptPayload, type CheckResult } from "./receipts.js";

/**
 * Monthly summary (docs/security/evidence-harness.md, phase 3). The daily run
 * calls ensureMonthlySummaries at its end. The first call in a UTC month
 * appends one receipt of kind summary for the previous calendar month and
 * emails it to each owner address, who forwards it to the customer's security
 * reviewer. The reviewer's copy holds the chain head outside the owner's
 * control.
 *
 * Catch-up: months without a summary after the newest one, up to the previous
 * month, are appended oldest first (at most the three most recent of them),
 * so a month in which no daily run happened still gets its summary. Emails:
 * the summaries of the previous month and the two before it go to every
 * configured recipient without a send record for that month, one recipient
 * at a time, so a failing recipient is retried alone and an email still
 * pending when the month rolls over still goes out.
 *
 * pg-boss 10 allows one schedule per queue, and a new queue needs
 * pgboss:install, so the summary rides on the existing daily run instead of a
 * monthly queue.
 */

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

export interface SummaryEmail {
  subject: string;
  text: string;
  html: string;
}

export interface SummaryDeps {
  /** Configured recipient addresses; compared trimmed and lowercased. */
  recipients: () => string[];
  /** Sends one email to one recipient; throws on failure. */
  sendEmail: (to: string, email: SummaryEmail) => Promise<void>;
  /**
   * Called after a failed send or a send whose record could not be written
   * (with the recipient), and once per call when no recipient is configured
   * (without one). The email stays pending in every case.
   */
  reportEmailError?: (error: unknown, context: { month: string; receiptId: string; recipient?: string }) => Promise<void>;
}

export interface SummaryResult {
  created: boolean;
  month: string;
  receiptId: string | null;
  /** Recipients this call sent the month's summary to and recorded as sent. */
  sentTo: string[];
  /** Configured recipients still without a send record for the month after this call. */
  pending: string[];
}

/** Missing months appended per call, newest kept. */
const MAX_CATCH_UP_MONTHS = 3;
/** The previous month and the two before it get their pending emails. */
const EMAIL_MONTHS = 3;

type Counts = { pass: number; fail: number; error: number };
type LatestResult = CheckResult | null;

export interface SummaryOutputs {
  checks: Array<{ checkId: string; kind: string; controls: string[]; counts: Counts; latestResult: LatestResult }>;
  controls: Array<{
    control: string;
    checkIds: string[];
    results: { pass: number; fail: number; error: number; none: number };
  }>;
  failures: Array<{ checkId: string; result: CheckResult; summary: string; sequence: number; recordedAt: string }>;
  knownGaps: Array<{ checkId: string; poamId: string; expiresOn: string | null }>;
  attestations: Array<{ checkId: string; lastPassAt: string | null; due: boolean }>;
  chainHead: { sequence: number; receiptHash: string; recordedAt: string } | null;
}

/**
 * Same key as append_evidence_receipt (0012, 0020). Holding it in the
 * summary's transaction keeps every other append out between reading the
 * chain head and appending the summary, so chainHead equals the summary's
 * previous_hash. The function takes the lock again; a transaction-level
 * advisory lock is reentrant within one session.
 */
const HASH_CHAIN_LOCK = "truenote.evidence_receipts.hash_chain";

export const SUMMARY_EMAIL_KEY_PREFIX = "evidence_summary_email_";

/**
 * SQL condition: the receipt's check_id is one of `checks` and its check_kind
 * is that check's catalog kind. A receipt that names a catalog check id under
 * another kind is not evidence for that check. `checks` must not be empty.
 */
export function catalogCheckMatch(checks: readonly CheckDefinition[]): SQL {
  return sql`(check_id, check_kind) IN (${sql.join(
    checks.map((check) => sql`(${check.id}::text, ${check.kind}::text)`),
    sql`, `
  )})`;
}

function summaryCheck(): CheckDefinition {
  const check = EVIDENCE_CHECKS.find((c) => c.kind === "summary");
  if (!check) throw new Error("the evidence catalog has no check of kind summary");
  return check;
}

type MonthWindow = { month: string; start: Date; end: Date };

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

function monthLabel(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The UTC calendar month `offset` months after "YYYY-MM": "YYYY-MM" and [start, end). */
function monthWindow(month: string, offset = 0): MonthWindow {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const start = new Date(Date.UTC(year, mon - 1 + offset, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { month: monthLabel(start), start, end };
}

/** The UTC calendar month before `now`: "YYYY-MM" and [start, end). */
export function previousMonthWindow(now: Date): MonthWindow {
  return monthWindow(monthLabel(now), -1);
}

async function findSummary(
  executor: Executor,
  checkId: string,
  month: string
): Promise<{ id: string; sequence: number; receiptHash: string; payload: string } | null> {
  const result = await executor.execute(sql`
    SELECT id::text AS id, sequence, receipt_hash, payload
    FROM evidence_receipts
    WHERE check_id = ${checkId} AND check_kind = 'summary'
      AND (payload::jsonb -> 'inputs' ->> 'month') = ${month}
    ORDER BY sequence
    LIMIT 1
  `);
  const row = result.rows[0] as { id: string; sequence: string | number; receipt_hash: string; payload: string } | undefined;
  return row ? { id: row.id, sequence: Number(row.sequence), receiptHash: row.receipt_hash, payload: row.payload } : null;
}

async function buildOutputs(
  executor: Executor,
  window: { start: Date; end: Date },
  today: string
): Promise<Omit<SummaryOutputs, "chainHead">> {
  const checks = EVIDENCE_CHECKS.filter((check) => check.kind !== "summary");
  const start = window.start.toISOString();
  const end = window.end.toISOString();

  const countRows = await executor.execute(sql`
    SELECT check_id, result, count(*)::int AS n
    FROM evidence_receipts
    WHERE ${catalogCheckMatch(checks)} AND recorded_at >= ${start}::timestamptz AND recorded_at < ${end}::timestamptz
    GROUP BY check_id, result
  `);
  const latestRows = await executor.execute(sql`
    SELECT DISTINCT ON (check_id) check_id, result, sequence, recorded_at_text,
           (payload::jsonb ->> 'summary') AS summary
    FROM evidence_receipts
    WHERE ${catalogCheckMatch(checks)} AND recorded_at >= ${start}::timestamptz AND recorded_at < ${end}::timestamptz
    ORDER BY check_id, sequence DESC
  `);
  const gapRows = await executor.execute(sql`
    SELECT check_id, poam_id, expires_on::text AS expires_on
    FROM evidence_known_gaps
    WHERE retired_at IS NULL AND (expires_on IS NULL OR expires_on >= ${today}::date)
    ORDER BY check_id, poam_id
  `);
  const attestationIds = checks.filter((check) => check.kind === "attestation").map((check) => check.id);
  const passRows =
    attestationIds.length === 0
      ? { rows: [] }
      : await executor.execute(sql`
          SELECT check_id,
                 to_char(max(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_pass_at
          FROM evidence_receipts
          WHERE check_kind = 'attestation' AND result = 'pass' AND check_id IN ${attestationIds}
            AND recorded_at < ${end}::timestamptz
          GROUP BY check_id
        `);

  const counts = new Map<string, Counts>();
  for (const row of countRows.rows as Array<{ check_id: string; result: CheckResult; n: number }>) {
    const entry = counts.get(row.check_id) ?? { pass: 0, fail: 0, error: 0 };
    if (row.result in entry) entry[row.result] += Number(row.n);
    counts.set(row.check_id, entry);
  }
  const latest = new Map(
    (latestRows.rows as Array<{ check_id: string; result: CheckResult; sequence: string | number; recorded_at_text: string; summary: string | null }>).map(
      (row) => [row.check_id, row]
    )
  );

  const checkEntries = checks.map((check) => ({
    checkId: check.id,
    kind: check.kind,
    controls: [...check.controls],
    counts: counts.get(check.id) ?? { pass: 0, fail: 0, error: 0 },
    latestResult: (latest.get(check.id)?.result ?? null) as LatestResult
  }));

  const controlMap = new Map<string, SummaryOutputs["controls"][number]>();
  for (const entry of checkEntries) {
    for (const control of entry.controls) {
      const item = controlMap.get(control) ?? { control, checkIds: [], results: { pass: 0, fail: 0, error: 0, none: 0 } };
      item.checkIds.push(entry.checkId);
      item.results[entry.latestResult ?? "none"] += 1;
      controlMap.set(control, item);
    }
  }
  const controls = [...controlMap.values()].sort((a, b) => a.control.localeCompare(b.control, "en", { numeric: true }));

  const failures = checkEntries
    .filter((entry) => entry.latestResult === "fail" || entry.latestResult === "error")
    .map((entry) => {
      const row = latest.get(entry.checkId)!;
      return {
        checkId: entry.checkId,
        result: row.result,
        summary: row.summary ?? "",
        sequence: Number(row.sequence),
        recordedAt: row.recorded_at_text
      };
    });

  const knownGaps = (gapRows.rows as Array<{ check_id: string; poam_id: string; expires_on: string | null }>).map((row) => ({
    checkId: row.check_id,
    poamId: row.poam_id,
    expiresOn: row.expires_on
  }));

  const lastPass = Object.fromEntries(
    (passRows.rows as Array<{ check_id: string; last_pass_at: string | null }>).map((row) => [row.check_id, row.last_pass_at])
  );
  const due = new Set(dueAttestations(window.end, lastPass).map((entry) => entry.checkId));
  const attestations = attestationIds.map((checkId) => ({
    checkId,
    lastPassAt: lastPass[checkId] ?? null,
    due: due.has(checkId)
  }));

  return { checks: checkEntries, controls, failures, knownGaps, attestations };
}

function latestTotals(outputs: Pick<SummaryOutputs, "checks">): { pass: number; fail: number; error: number; none: number } {
  const totals = { pass: 0, fail: 0, error: 0, none: 0 };
  for (const check of outputs.checks) totals[check.latestResult ?? "none"] += 1;
  return totals;
}

/** Check counts by latest result, for GET /summaries. */
export function summaryCounts(outputs: unknown): { pass: number; fail: number; error: number; none: number } {
  const checks = (outputs as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(checks)) return { pass: 0, fail: 0, error: 0, none: 0 };
  return latestTotals({
    checks: checks.map((check) => {
      const result = (check as { latestResult?: unknown } | null)?.latestResult;
      return { latestResult: result === "pass" || result === "fail" || result === "error" ? result : null };
    }) as SummaryOutputs["checks"]
  });
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

export function renderSummaryEmail(
  month: string,
  outputs: SummaryOutputs,
  receipt: { id: string; sequence: number; receiptHash: string }
): SummaryEmail {
  const totals = latestTotals(outputs);
  const receiptTotals = outputs.checks.reduce(
    (acc, check) => ({
      pass: acc.pass + check.counts.pass,
      fail: acc.fail + check.counts.fail,
      error: acc.error + check.counts.error
    }),
    { pass: 0, fail: 0, error: 0 }
  );
  const overdue = outputs.attestations.filter((entry) => entry.due);
  const head = outputs.chainHead;

  const sections: Array<{ heading: string; lines: string[] }> = [
    {
      heading: `Truenote evidence summary for ${month} (UTC calendar month)`,
      lines: [
        `Checks by latest result: ${totals.pass} pass, ${totals.fail} fail, ${totals.error} error, ` +
          `${totals.none} without a receipt (${outputs.checks.length} checks).`,
        `Receipts recorded in the month: ${receiptTotals.pass} pass, ${receiptTotals.fail} fail, ${receiptTotals.error} error.`
      ]
    },
    {
      heading: "Failures (latest result fail or error)",
      lines:
        outputs.failures.length === 0
          ? ["None."]
          : outputs.failures.map((f) => `${f.checkId} (${f.result}, receipt ${f.sequence}, ${f.recordedAt}): ${oneLine(f.summary)}`)
    },
    {
      heading: "Known gaps (active POA&M links)",
      lines:
        outputs.knownGaps.length === 0
          ? ["None."]
          : outputs.knownGaps.map((g) => `${g.checkId}: ${g.poamId} (${g.expiresOn ? `expires ${g.expiresOn}` : "no expiry"})`)
    },
    {
      heading: "Attestations overdue at the end of the month",
      lines:
        overdue.length === 0
          ? ["None."]
          : overdue.map((a) => `${a.checkId} (${a.lastPassAt ? `last attested ${a.lastPassAt}` : "never attested"})`)
    },
    {
      heading: "Chain head",
      lines: [
        head
          ? `Before this summary: sequence ${head.sequence}, receipt_hash ${head.receiptHash}, recorded ${head.recordedAt}.`
          : "Before this summary: no receipts.",
        `This summary: receipt ${receipt.id}, sequence ${receipt.sequence}, receipt_hash ${receipt.receiptHash}.`,
        "Forward this email to the customer's security reviewer; their copy keeps the chain head outside the operator's control."
      ]
    },
    { heading: "Statement", lines: [ASSESSMENT_STATEMENT] }
  ];

  return {
    subject: `Truenote evidence summary ${month}: ${totals.fail} fail, ${totals.error} error, ${overdue.length} attestation(s) overdue`,
    text: sections.map((s) => [s.heading, ...s.lines.map((line) => `- ${line}`)].join("\n")).join("\n\n"),
    html: sections
      .map((s) => `<h3>${escapeHtml(s.heading)}</h3><ul>${s.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>`)
      .join("")
  };
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** Configured recipients, trimmed, without empties or duplicates (compared lowercased). */
function configuredRecipients(deps: SummaryDeps): Array<{ to: string; key: string }> {
  const seen = new Set<string>();
  const out: Array<{ to: string; key: string }> = [];
  for (const raw of deps.recipients()) {
    const to = raw.trim();
    const key = normalizeAddress(to);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ to, key });
  }
  return out;
}

/**
 * The app_settings record of a month's summary email:
 * { receiptId, sentTo: { "<address, trimmed and lowercased>": "<ISO time>" } }.
 */
async function sentRecipients(month: string): Promise<Set<string>> {
  const result = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${SUMMARY_EMAIL_KEY_PREFIX + month}`);
  const value = (result.rows[0] as { value: unknown } | undefined)?.value;
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const sentTo = (parsed as { sentTo?: unknown } | null | undefined)?.sentTo;
  if (!sentTo || typeof sentTo !== "object" || Array.isArray(sentTo)) return new Set();
  return new Set(Object.keys(sentTo).map(normalizeAddress));
}

async function markRecipientSent(month: string, receiptId: string, recipientKey: string): Promise<void> {
  const entry = JSON.stringify({ [recipientKey]: new Date().toISOString() });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (
      ${SUMMARY_EMAIL_KEY_PREFIX + month},
      jsonb_build_object('receiptId', ${receiptId}::text, 'sentTo', ${entry}::jsonb),
      now()
    )
    ON CONFLICT (key) DO UPDATE SET
      value = jsonb_build_object(
        'receiptId', ${receiptId}::text,
        'sentTo', COALESCE(app_settings.value -> 'sentTo', '{}'::jsonb) || ${entry}::jsonb
      ),
      updated_at = now()
  `);
}

type StoredSummary = { id: string; sequence: number; receiptHash: string; outputs: SummaryOutputs };

/** The newest month that has a summary receipt, or null. */
async function newestSummaryMonth(checkId: string): Promise<string | null> {
  const result = await db.execute(sql`
    SELECT max(payload::jsonb -> 'inputs' ->> 'month') AS month
    FROM evidence_receipts
    WHERE check_id = ${checkId} AND check_kind = 'summary'
  `);
  const month = (result.rows[0] as { month: string | null } | undefined)?.month ?? null;
  return month && MONTH_PATTERN.test(month) ? month : null;
}

/** The months to append: after the newest summary up to the previous month, the most recent few, oldest first. */
function monthsToCreate(newest: string | null, previous: string): string[] {
  if (newest === null) return [previous];
  const months: string[] = [];
  for (let k = 1; ; k++) {
    const month = monthWindow(newest, k).month;
    if (month > previous) break;
    months.push(month);
  }
  return months.slice(-MAX_CATCH_UP_MONTHS);
}

/**
 * Append the month's summary receipt unless one exists, in one transaction
 * under the chain lock, so its chainHead is the receipt it links to.
 */
async function storeSummary(check: CheckDefinition, window: MonthWindow, today: string): Promise<StoredSummary & { created: boolean }> {
  const { month } = window;
  const startedAt = new Date();
  return db.transaction(async (tx) => {
    const executor = tx as unknown as Executor;
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${HASH_CHAIN_LOCK}))`);
    const existing = await findSummary(executor, check.id, month);
    if (existing) {
      return {
        created: false,
        id: existing.id,
        sequence: existing.sequence,
        receiptHash: existing.receiptHash,
        outputs: (JSON.parse(existing.payload) as { outputs: SummaryOutputs }).outputs
      };
    }
    const partial = await buildOutputs(executor, window, today);
    const headRows = await executor.execute(sql`
      SELECT sequence, receipt_hash, recorded_at_text
      FROM evidence_receipts
      ORDER BY sequence DESC
      LIMIT 1
    `);
    const headRow = headRows.rows[0] as { sequence: string | number; receipt_hash: string; recorded_at_text: string } | undefined;
    const outputs: SummaryOutputs = {
      ...partial,
      chainHead: headRow
        ? { sequence: Number(headRow.sequence), receiptHash: headRow.receipt_hash, recordedAt: headRow.recorded_at_text }
        : null
    };
    const totals = latestTotals(outputs);
    const payload = buildReceiptPayload(
      check,
      {
        result: "pass",
        summary:
          `Summary for ${month}: ${totals.pass} pass, ${totals.fail} fail, ${totals.error} error, ` +
          `${totals.none} without a receipt (latest result per check); chain head ` +
          (outputs.chainHead ? `sequence ${outputs.chainHead.sequence}` : "empty"),
        inputs: { month, from: window.start.toISOString(), to: window.end.toISOString() },
        outputs: outputs as unknown as Record<string, unknown>
      },
      { runId: null, startedAt, finishedAt: new Date() }
    );
    const receipt = await appendReceipt(payload, executor);
    const linked = await executor.execute(sql`
      SELECT previous_hash FROM evidence_receipts WHERE id = ${receipt.id}::uuid
    `);
    const previousHash = (linked.rows[0] as { previous_hash: string | null } | undefined)?.previous_hash ?? null;
    if (previousHash !== (outputs.chainHead?.receiptHash ?? null)) {
      // Unreachable while the lock above matches append_evidence_receipt's; rolls the summary back if not.
      throw new Error("monthly summary chain head does not match the appended receipt's previous_hash");
    }
    return { created: true, id: receipt.id, sequence: receipt.sequence, receiptHash: receipt.receiptHash, outputs };
  });
}

async function readSummary(checkId: string, month: string): Promise<StoredSummary | null> {
  const found = await findSummary(db as unknown as Executor, checkId, month);
  if (!found) return null;
  return {
    id: found.id,
    sequence: found.sequence,
    receiptHash: found.receiptHash,
    outputs: (JSON.parse(found.payload) as { outputs: SummaryOutputs }).outputs
  };
}

/**
 * Append the summary of every month that lacks one (see monthsToCreate), then
 * send the summaries of the previous month and the two before it to each
 * configured recipient without a send record for that month. Each successful
 * send is recorded at once; a failed send, or a send whose record cannot be
 * written, is reported and stays pending for a later call. Never appends a
 * second receipt for a month.
 */
export async function ensureMonthlySummaries(now: Date, deps: SummaryDeps): Promise<SummaryResult[]> {
  const check = summaryCheck();
  const previous = previousMonthWindow(now).month;
  const today = now.toISOString().slice(0, 10);
  const results = new Map<string, SummaryResult>();

  for (const month of monthsToCreate(await newestSummaryMonth(check.id), previous)) {
    const stored = await storeSummary(check, monthWindow(month), today);
    results.set(month, { created: stored.created, month, receiptId: stored.id, sentTo: [], pending: [] });
  }

  const recipients = configuredRecipients(deps);
  let noRecipientReported = false;
  for (let k = EMAIL_MONTHS - 1; k >= 0; k--) {
    const month = monthWindow(previous, -k).month;
    const stored = await readSummary(check.id, month);
    if (!stored) continue;
    const result = results.get(month) ?? { created: false, month, receiptId: stored.id, sentTo: [], pending: [] };
    results.set(month, result);

    if (recipients.length === 0) {
      if (!noRecipientReported) {
        noRecipientReported = true;
        const error = new Error("no EVIDENCE_ALERT_EMAIL or SECURITY_ALERT_EMAIL; the summary emails stay pending");
        console.warn(`[evidence] ${error.message}`);
        await deps.reportEmailError?.(error, { month, receiptId: stored.id });
      }
      continue;
    }

    const sent = await sentRecipients(month);
    const pending = recipients.filter((r) => !sent.has(r.key));
    if (pending.length === 0) continue;
    const email = renderSummaryEmail(month, stored.outputs, stored);
    for (const recipient of pending) {
      try {
        await deps.sendEmail(recipient.to, email);
      } catch (error) {
        // Stays pending; a later call sends it again to this recipient only.
        console.warn(
          `[evidence] summary email for ${month} to ${recipient.to} not sent:`,
          error instanceof Error ? error.message : error
        );
        await deps.reportEmailError?.(error, { month, receiptId: stored.id, recipient: recipient.to });
        result.pending.push(recipient.to);
        continue;
      }
      try {
        await markRecipientSent(month, stored.id, recipient.key);
      } catch (error) {
        // The email went out but its send record did not. The recipient stays
        // pending, so the next call sends this month's summary to it again.
        console.warn(
          `[evidence] summary email for ${month} sent to ${recipient.to}, but its send record was not written:`,
          error instanceof Error ? error.message : error
        );
        await deps.reportEmailError?.(error, { month, receiptId: stored.id, recipient: recipient.to });
        result.pending.push(recipient.to);
        continue;
      }
      result.sentTo.push(recipient.to);
    }
  }

  return [...results.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * Production dependencies: recipients from EVIDENCE_ALERT_EMAIL, else
 * SECURITY_ALERT_EMAIL; each send within 30 s; a failed send or a missing
 * recipient goes to error_log.
 */
export function productionSummaryDeps(): SummaryDeps {
  return {
    recipients: () => evidenceAlertRecipients(),
    sendEmail: async (to, email) => {
      await withDeadline(getEmailSender().send({ to, ...email }), 30_000, "evidence summary email");
    },
    reportEmailError: async (error, context) => {
      await recordAppError({
        severity: "warning",
        source: "evidence",
        operation: "evidence-summary-email",
        error,
        context
      });
    }
  };
}
