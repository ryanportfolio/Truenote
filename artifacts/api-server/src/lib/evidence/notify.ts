import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { getEmailSender } from "../email/sender.js";
import { escapeHtml } from "../email/templates.js";
import type { CheckResult } from "./receipts.js";
import type { RunEntry } from "./runner.js";

/**
 * Emails the owner (EVIDENCE_ALERT_EMAIL) when a run changes something that
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

export function renderRunEmail(runId: string, classified: ClassifiedEntry[]): { subject: string; text: string; html: string } | null {
  const attention = classified.filter((entry) => ATTENTION.includes(entry.notice));
  if (attention.length === 0) return null;
  const recovered = classified.filter((entry) => entry.notice === "recovered");
  const label: Record<Notice, string> = {
    "new-failure": "New failure",
    "gap-expired": "Known-gap link expired",
    "repeated-error": "Could not run twice in a row",
    recovered: "Recovered",
    "known-gap": "Known gap",
    unchanged: "Unchanged"
  };
  const lines = [...attention, ...recovered].map(
    (entry) => `${label[entry.notice]}: ${entry.checkId} (${entry.result}) ${entry.summary}`
  );
  const subject = `Truenote evidence: ${attention.length} check(s) need attention`;
  const text = [
    `Evidence run ${runId}.`,
    "",
    ...lines,
    "",
    "Receipts: GET /api/admin/evidence/failures (super_user)."
  ].join("\n");
  const html = `<p>Evidence run ${escapeHtml(runId)}.</p><ul>${lines
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("")}</ul><p>Receipts: GET /api/admin/evidence/failures (super_user).</p>`;
  return { subject, text, html };
}

export async function notifyRun(runId: string, entries: RunEntry[]): Promise<ClassifiedEntry[]> {
  const classified = await classifyRun(entries);
  const email = renderRunEmail(runId, classified);
  if (!email) return classified;
  const to = process.env.EVIDENCE_ALERT_EMAIL;
  if (!to) {
    console.warn(`[evidence] ${email.subject}; EVIDENCE_ALERT_EMAIL is not set, so no email was sent`);
    return classified;
  }
  await getEmailSender().send({ to, ...email });
  return classified;
}
