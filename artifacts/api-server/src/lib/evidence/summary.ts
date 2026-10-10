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
 * calls ensureMonthlySummary at its end; the first call in a UTC month appends
 * one receipt of kind summary for the previous calendar month and emails it to
 * the owner, who forwards it to the customer's security reviewer. The
 * reviewer's copy holds the chain head outside the owner's control.
 *
 * pg-boss 10 allows one schedule per queue, and a new queue needs
 * pgboss:install, so the summary rides on the existing daily run instead of a
 * monthly queue. Every later call in the month finds the receipt and only
 * retries an email that has not gone out.
 */

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

export interface SummaryEmail {
  subject: string;
  text: string;
  html: string;
}

export interface SummaryDeps {
  sendEmail: (email: SummaryEmail) => Promise<void>;
  /** Called after a failed send; the receipt stays and a later call retries. */
  reportEmailError?: (error: unknown, context: { month: string; receiptId: string }) => Promise<void>;
}

export interface SummaryResult {
  created: boolean;
  month: string;
  receiptId: string | null;
  emailed: boolean;
}

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

function summaryCheck(): CheckDefinition {
  const check = EVIDENCE_CHECKS.find((c) => c.kind === "summary");
  if (!check) throw new Error("the evidence catalog has no check of kind summary");
  return check;
}

/** The UTC calendar month before `now`: "YYYY-MM" and [start, end). */
export function previousMonthWindow(now: Date): { month: string; start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const month = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { month, start, end };
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
  const ids = checks.map((check) => check.id);
  const start = window.start.toISOString();
  const end = window.end.toISOString();

  const countRows = await executor.execute(sql`
    SELECT check_id, result, count(*)::int AS n
    FROM evidence_receipts
    WHERE check_id IN ${ids} AND recorded_at >= ${start}::timestamptz AND recorded_at < ${end}::timestamptz
    GROUP BY check_id, result
  `);
  const latestRows = await executor.execute(sql`
    SELECT DISTINCT ON (check_id) check_id, result, sequence, recorded_at_text,
           (payload::jsonb ->> 'summary') AS summary
    FROM evidence_receipts
    WHERE check_id IN ${ids} AND recorded_at >= ${start}::timestamptz AND recorded_at < ${end}::timestamptz
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

async function emailAlreadySent(month: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT 1 FROM app_settings WHERE key = ${SUMMARY_EMAIL_KEY_PREFIX + month}`);
  return result.rows.length > 0;
}

async function markEmailSent(month: string, receiptId: string): Promise<void> {
  const value = JSON.stringify({ receiptId, sentAt: new Date().toISOString() });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${SUMMARY_EMAIL_KEY_PREFIX + month}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

/**
 * Append the previous month's summary receipt unless it exists, then email it
 * unless app_settings records that its email went out. A failed send leaves
 * the receipt and no record, so a later call sends it; it never appends a
 * second receipt for the month.
 */
export async function ensureMonthlySummary(now: Date, deps: SummaryDeps): Promise<SummaryResult> {
  const check = summaryCheck();
  const window = previousMonthWindow(now);
  const { month } = window;
  const startedAt = new Date();
  const today = now.toISOString().slice(0, 10);

  const stored = await db.transaction(async (tx) => {
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

  const result: SummaryResult = { created: stored.created, month, receiptId: stored.id, emailed: false };
  if (await emailAlreadySent(month)) return result;

  try {
    await deps.sendEmail(renderSummaryEmail(month, stored.outputs, stored));
  } catch (error) {
    // The receipt stays; the next daily run sends the email again.
    console.warn(`[evidence] summary email for ${month} not sent:`, error instanceof Error ? error.message : error);
    await deps.reportEmailError?.(error, { month, receiptId: stored.id });
    return result;
  }
  await markEmailSent(month, stored.id);
  return { ...result, emailed: true };
}

/**
 * Production sender: one email per recipient (EVIDENCE_ALERT_EMAIL, else
 * SECURITY_ALERT_EMAIL), each within 30 s. No recipient throws, so the email
 * stays pending until one is configured. A failed send goes to error_log.
 */
export function productionSummaryDeps(): SummaryDeps {
  return {
    sendEmail: async (email) => {
      const recipients = evidenceAlertRecipients();
      if (recipients.length === 0) {
        throw new Error("no EVIDENCE_ALERT_EMAIL or SECURITY_ALERT_EMAIL; the summary email stays pending");
      }
      for (const to of recipients) {
        await withDeadline(getEmailSender().send({ to, ...email }), 30_000, "evidence summary email");
      }
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
