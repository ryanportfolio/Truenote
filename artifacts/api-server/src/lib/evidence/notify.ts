import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { getEmailSender } from "../email/sender.js";
import { escapeHtml } from "../email/templates.js";
import { securityAlertRecipients, withDeadline } from "../monitoring/alert-email.js";
import type { CheckResult } from "./receipts.js";
import type { RunEntry } from "./runner.js";

/**
 * Emails the owner (EVIDENCE_ALERT_EMAIL, else the security monitor's
 * SECURITY_ALERT_EMAIL, comma-separated) when a run changes something that
 * needs attention. One email per run at most, and only on a change, so a
 * failure that stays failing does not repeat daily:
 *
 * - new-failure: fail now, not fail on the previous receipt, and no active
 *   known-gap link (evidence_known_gaps) for the check;
 * - gap-expired: fail now, the check's gap link expired since the previous
 *   receipt;
 * - repeated-error: error now and on the previous receipt, but not on the one
 *   before (two in a row, reported once);
 * - recovered: pass now after a fail or error (listed only when an email is
 *   sent anyway).
 */

export type Notice = "new-failure" | "gap-expired" | "repeated-error" | "recovered" | "known-gap" | "unchanged";

export interface PriorReceipt {
  result: CheckResult;
  recordedAt: string;
}

export interface KnownGap {
  poamId: string;
  expiresOn: string | null;
}

export function classify(
  current: CheckResult,
  prior: PriorReceipt[],
  gap: KnownGap | null,
  today: string
): Notice {
  const [previous, beforePrevious] = prior;
  if (current === "fail") {
    const gapActive = gap && (gap.expiresOn === null || gap.expiresOn >= today);
    if (gap && !gapActive && previous && previous.recordedAt.slice(0, 10) <= gap.expiresOn!) {
      return "gap-expired";
    }
    if (previous?.result === "fail") return gapActive ? "known-gap" : "unchanged";
    return gapActive ? "known-gap" : "new-failure";
  }
  if (current === "error") {
    if (previous?.result === "error" && beforePrevious?.result !== "error") return "repeated-error";
    return "unchanged";
  }
  if (previous && previous.result !== "pass") return "recovered";
  return "unchanged";
}

const ATTENTION: Notice[] = ["new-failure", "gap-expired", "repeated-error"];

export interface ClassifiedEntry extends RunEntry {
  notice: Notice;
  gap: KnownGap | null;
}

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

export async function classifyRun(
  entries: RunEntry[],
  today = new Date().toISOString().slice(0, 10),
  executor: Executor = db as unknown as Executor
): Promise<ClassifiedEntry[]> {
  if (entries.length === 0) return [];
  const ids = entries.map((entry) => entry.checkId);
  const firstSequence = Math.min(...entries.map((entry) => entry.receipt.sequence));
  const priorRows = await executor.execute(sql`
    SELECT check_id, result, recorded_at_text
    FROM (
      SELECT check_id, result, recorded_at_text,
             row_number() OVER (PARTITION BY check_id ORDER BY sequence DESC) AS rn
      FROM evidence_receipts
      WHERE check_id IN ${ids} AND sequence < ${firstSequence}
    ) ranked
    WHERE rn <= 2
    ORDER BY check_id, rn
  `);
  const gapRows = await executor.execute(sql`
    SELECT check_id, poam_id, expires_on::text AS expires_on
    FROM evidence_known_gaps
    WHERE retired_at IS NULL AND check_id IN ${ids}
    ORDER BY expires_on DESC NULLS FIRST
  `);
  const prior = new Map<string, PriorReceipt[]>();
  for (const row of priorRows.rows as Array<{ check_id: string; result: CheckResult; recorded_at_text: string }>) {
    const list = prior.get(row.check_id) ?? [];
    list.push({ result: row.result, recordedAt: row.recorded_at_text });
    prior.set(row.check_id, list);
  }
  const gaps = new Map<string, KnownGap>();
  for (const row of gapRows.rows as Array<{ check_id: string; poam_id: string; expires_on: string | null }>) {
    // Latest-expiring link wins; a link without expiry sorts first.
    if (!gaps.has(row.check_id)) gaps.set(row.check_id, { poamId: row.poam_id, expiresOn: row.expires_on });
  }
  return entries.map((entry) => {
    const gap = gaps.get(entry.checkId) ?? null;
    return { ...entry, gap, notice: classify(entry.result, prior.get(entry.checkId) ?? [], gap, today) };
  });
}

const LABEL: Record<Notice, string> = {
  "new-failure": "New failure",
  "gap-expired": "Known-gap link expired",
  "repeated-error": "Could not run twice in a row",
  recovered: "Recovered",
  "known-gap": "Known gap",
  unchanged: "Unchanged"
};

/** Alert lines for one run: attention items, plus recoveries when there are any. */
export function alertLines(runId: string, classified: ClassifiedEntry[]): string[] {
  const attention = classified.filter((entry) => ATTENTION.includes(entry.notice));
  if (attention.length === 0) return [];
  const recovered = classified.filter((entry) => entry.notice === "recovered");
  return [...attention, ...recovered].map(
    (entry) => `${LABEL[entry.notice]}: ${entry.checkId} (${entry.result}, run ${runId.slice(0, 8)}) ${entry.summary}`
  );
}

export function renderAlertEmail(lines: string[]): { subject: string; text: string; html: string } {
  const count = lines.filter((line) => !line.startsWith(LABEL.recovered)).length;
  const footer = "Receipts: GET /api/admin/evidence/failures (super_user).";
  return {
    subject: `Truenote evidence: ${count} check(s) need attention`,
    text: [...lines, "", footer].join("\n"),
    html: `<ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>${escapeHtml(footer)}</p>`
  };
}

/**
 * Undelivered alert lines live in app_settings (key evidence_pending_alert)
 * until an email succeeds. Without this, a failed send would be lost: the
 * next run sees the failure as unchanged and does not alert again.
 */
const PENDING_KEY = "evidence_pending_alert";
const MAX_PENDING_LINES = 200;

async function readPending(): Promise<string[]> {
  const result = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${PENDING_KEY}`);
  const value = (result.rows[0] as { value?: { lines?: unknown } } | undefined)?.value;
  return Array.isArray(value?.lines) ? value.lines.filter((line): line is string => typeof line === "string") : [];
}

async function writePending(lines: string[]): Promise<void> {
  if (lines.length === 0) {
    await db.execute(sql`DELETE FROM app_settings WHERE key = ${PENDING_KEY}`);
    return;
  }
  const value = JSON.stringify({ lines: lines.slice(-MAX_PENDING_LINES), updatedAt: new Date().toISOString() });
  await db.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${PENDING_KEY}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

/**
 * Classify a run and send one email with this run's alert lines plus any
 * still undelivered from earlier runs. Lines stay pending until a send
 * succeeds; every run retries them.
 */
export async function notifyRun(runId: string, entries: RunEntry[]): Promise<ClassifiedEntry[]> {
  const classified = await classifyRun(entries);
  const pending = await readPending();
  const lines = [...pending, ...alertLines(runId, classified)];
  if (lines.length === 0) return classified;
  if (lines.length > pending.length) await writePending(lines);
  const recipients = evidenceAlertRecipients();
  if (recipients.length === 0) {
    console.warn(`[evidence] ${lines.length} alert line(s) pending; no EVIDENCE_ALERT_EMAIL or SECURITY_ALERT_EMAIL`);
    return classified;
  }
  const email = renderAlertEmail(lines);
  for (const to of recipients) {
    await withDeadline(getEmailSender().send({ to, ...email }), 30_000, "evidence alert email");
  }
  await writePending([]);
  return classified;
}

/** EVIDENCE_ALERT_EMAIL when set, else the security monitor's recipients. */
export function evidenceAlertRecipients(env: NodeJS.ProcessEnv = process.env): string[] {
  return env.EVIDENCE_ALERT_EMAIL
    ? securityAlertRecipients({ SECURITY_ALERT_EMAIL: env.EVIDENCE_ALERT_EMAIL })
    : securityAlertRecipients(env);
}
