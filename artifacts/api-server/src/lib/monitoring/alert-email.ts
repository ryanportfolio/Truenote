import { getEmailSender } from "../email/sender.js";
import { safeErrorMessage } from "../observability/error-log.js";

export interface SecurityAlert {
  rule: string;
  summary: string;
  lines: string[];
}

/**
 * Recipients come from SECURITY_ALERT_EMAIL (comma-separated). When it is
 * unset, alerts still go to the process log as `[security-alert]` lines, which
 * the daily log export keeps.
 */
export function securityAlertRecipients(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return (env.SECURITY_ALERT_EMAIL ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.includes("@"));
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One log line per alert, JSON-encoded so field values cannot forge lines. */
export function logSecurityAlert(alert: SecurityAlert): void {
  logJsonLine("[security-alert]", {
    rule: alert.rule,
    summary: alert.summary,
    lines: alert.lines
  });
}

/**
 * Print `prefix {json}` on one physical line. JSON.stringify leaves U+2028
 * and U+2029 unescaped; some log viewers split on them.
 */
export function logJsonLine(prefix: string, value: unknown): void {
  console.log(
    `${prefix} ${JSON.stringify(value)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029")}`
  );
}

/**
 * Message of the innermost `cause`. Drizzle wraps a database error as
 * "Failed query: <sql> params: ..." and keeps Postgres' own reason (for
 * example "permission denied for function ...") in `cause`, which is the
 * part a responder needs.
 */
export function rootErrorMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const cause = (current as { cause?: unknown } | null)?.cause;
    if (cause === undefined || cause === null) break;
    current = cause;
  }
  return safeErrorMessage(current);
}

/** Reject when `promise` has not settled within `ms`. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const SEND_DEADLINE_MS = 30_000;
let missingRecipientWarned = false;

/**
 * Logs every alert, then emails them as one message. Returns false only when
 * a configured send failed, so the caller can retry on its next pass.
 */
export async function deliverSecurityAlerts(
  alerts: SecurityAlert[],
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (alerts.length === 0) return true;
  for (const alert of alerts) logSecurityAlert(alert);
  const recipients = securityAlertRecipients(env);
  if (recipients.length === 0) {
    if (!missingRecipientWarned) {
      console.warn(
        "[security-alert] SECURITY_ALERT_EMAIL is not set; alerts are logged only."
      );
      missingRecipientWarned = true;
    }
    return true;
  }
  const subject = oneLine(
    alerts.length === 1
      ? `[Truenote] Security alert: ${alerts[0]!.summary}`
      : `[Truenote] ${alerts.length} security alerts`
  ).slice(0, 200);
  const text = alerts
    .map((alert) => [`${alert.summary} (${alert.rule})`, ...alert.lines.map((l) => `  ${l}`)].join("\n"))
    .join("\n\n");
  const html = alerts
    .map(
      (alert) =>
        `<p><strong>${escapeHtml(alert.summary)}</strong> (${escapeHtml(alert.rule)})</p>` +
        `<ul>${alert.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
    )
    .join("");
  try {
    const sender = getEmailSender();
    for (const to of recipients) {
      await withDeadline(
        sender.send({
          to,
          subject,
          text: `${text}\n\nSource: Truenote security monitor. Review in security_events and the exported logs.`,
          html: `${html}<p>Source: Truenote security monitor. Review in security_events and the exported logs.</p>`
        }),
        SEND_DEADLINE_MS,
        "alert email"
      );
    }
    return true;
  } catch (error) {
    console.error("[security-alert] email delivery failed:", safeErrorMessage(error));
    return false;
  }
}

const AUDIT_FAILURE_EMAIL_INTERVAL_MS = 15 * 60 * 1000;
let lastAuditFailureEmailAt = 0;
let suppressedAuditFailures = 0;

/**
 * A security event could not be written. This path does not touch the
 * database, so it still alerts when Postgres is the thing that failed. The
 * first failure emails at once; later ones in the next 15 minutes are counted
 * and reported with the next email. Every failure is logged.
 */
export function reportAuditWriteFailure(
  action: string,
  outcome: string,
  error: unknown,
  now: () => number = Date.now
): void {
  const message = rootErrorMessage(error).slice(0, 300);
  console.error(
    `[security-audit] append failed ${JSON.stringify({ action, outcome, error: message })}`
  );
  const at = now();
  if (at - lastAuditFailureEmailAt < AUDIT_FAILURE_EMAIL_INTERVAL_MS) {
    suppressedAuditFailures += 1;
    return;
  }
  const earlier = suppressedAuditFailures;
  lastAuditFailureEmailAt = at;
  suppressedAuditFailures = 0;
  void deliverSecurityAlerts([
    {
      rule: "audit_write_failure",
      summary: "Security event could not be written",
      lines: [
        `Process: ${process.env.TRUENOTE_PROCESS ?? "unknown"}`,
        `Event: ${action} (${outcome})`,
        `Error: ${message}`,
        ...(earlier > 0
          ? [`Other failures since the previous alert email: ${earlier}`]
          : [])
      ]
    }
  ]);
}
