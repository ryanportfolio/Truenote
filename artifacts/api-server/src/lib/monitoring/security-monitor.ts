import { sql, type SQL } from "drizzle-orm";
import { db, withPgAdvisoryLock } from "../db-client.js";
import { safeErrorMessage } from "../observability/error-log.js";
import {
  deliverSecurityAlerts,
  logJsonLine,
  type SecurityAlert
} from "./alert-email.js";

/**
 * Worker job, once a minute:
 *
 * 1. Print every security_events row committed since the last pass as one
 *    `[security-event] {json}` log line, in sequence order. The daily export
 *    of Railway logs to the private ops repository carries these lines off
 *    Railway. On first run the cursor starts at 0, so the whole existing
 *    chain is printed, 200 rows a pass.
 * 2. Check the new rows and the last 15 minutes against the alert rules
 *    below and email SECURITY_ALERT_EMAIL.
 *
 * The cursor (security_monitor_state, lib/db/sql/0011) advances only after
 * the alerts for the batch were delivered, so a failed email is retried on
 * the next pass. A retried batch is printed again; the event id identifies
 * duplicates.
 */

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

const POLL_MS = 60_000;
const BATCH_SIZE = 200;
/** Rows older than this are mirrored but never alerted on (history catch-up). */
const ALERT_FRESHNESS_MS = 60 * 60 * 1000;
const WINDOW_MINUTES = 15;
const WINDOW_COOLDOWN_MS = 60 * 60 * 1000;
const FAILED_LOGINS_PER_IP = 10;
const FAILED_LOGINS_TOTAL = 25;
const DENIED_TOTAL = 50;
const FAILED_PASSES_BEFORE_ALERT = 5;
const LINES_PER_ALERT = 20;
const LOCK_KEY = "truenote.security_monitor";

export interface MonitoredEvent {
  sequence: number;
  id: string;
  occurredAt: string;
  action: string;
  outcome: string;
  actorUserId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  programId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  requestId: string | null;
  sourceIp: string | null;
  details: unknown;
  eventHash: string;
}

const ACCOUNT_ROUTE = /^(POST|PUT|PATCH|DELETE) \/api\/admin\/users(\/|$)/;

/** The single-event rules. Returns null when the event raises no alert. */
export function eventAlertRule(
  event: MonitoredEvent
): { rule: string; summary: string } | null {
  if (event.action === "auth.break_glass.login") {
    return { rule: "break_glass_login", summary: "Break-glass login" };
  }
  if (
    (event.action === "auth.local.login" || event.action === "auth.oidc.login") &&
    event.outcome === "success" &&
    event.actorRole === "super_user"
  ) {
    return { rule: "super_user_login", summary: "Super user login" };
  }
  if (
    event.action.startsWith("admin.user.") ||
    (event.action === "http.security_mutation" &&
      event.outcome === "success" &&
      event.resourceId !== null &&
      ACCOUNT_ROUTE.test(event.resourceId))
  ) {
    return { rule: "account_change", summary: "User account or role change" };
  }
  if (event.action.startsWith("security.")) {
    return { rule: "security_setting_change", summary: "Security setting change" };
  }
  if (event.action === "error_log.clear") {
    return { rule: "error_log_cleared", summary: "Error log cleared" };
  }
  return null;
}

function describe(event: MonitoredEvent): string {
  return [
    event.occurredAt,
    event.action,
    event.outcome,
    `actor=${event.actorEmail ?? "-"} (${event.actorRole ?? "-"})`,
    `ip=${event.sourceIp ?? "-"}`,
    `resource=${event.resourceId ?? "-"}`,
    `seq=${event.sequence}`
  ].join(" ");
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toEvent(row: Record<string, unknown>): MonitoredEvent {
  const occurred = row["occurred_at"];
  return {
    sequence: Number(row["sequence"]),
    id: String(row["id"]),
    occurredAt:
      occurred instanceof Date ? occurred.toISOString() : String(occurred),
    action: String(row["action"]),
    outcome: String(row["outcome"]),
    actorUserId: nullableString(row["actor_user_id"]),
    actorEmail: nullableString(row["actor_email"]),
    actorRole: nullableString(row["actor_role"]),
    programId: nullableString(row["program_id"]),
    resourceType: nullableString(row["resource_type"]),
    resourceId: nullableString(row["resource_id"]),
    requestId: nullableString(row["request_id"]),
    sourceIp: nullableString(row["source_ip"]),
    details: row["details"] ?? {},
    eventHash: String(row["event_hash"])
  };
}

export function eventAlerts(
  events: MonitoredEvent[],
  nowMs: number
): SecurityAlert[] {
  const byRule = new Map<string, { summary: string; events: MonitoredEvent[] }>();
  for (const event of events) {
    if (nowMs - new Date(event.occurredAt).getTime() > ALERT_FRESHNESS_MS) continue;
    const match = eventAlertRule(event);
    if (!match) continue;
    const entry = byRule.get(match.rule) ?? { summary: match.summary, events: [] };
    entry.events.push(event);
    byRule.set(match.rule, entry);
  }
  return [...byRule].map(([rule, entry]) => {
    const lines = entry.events.slice(0, LINES_PER_ALERT).map(describe);
    const more = entry.events.length - lines.length;
    return {
      rule,
      summary:
        entry.events.length === 1
          ? entry.summary
          : `${entry.summary} (${entry.events.length})`,
      lines: more > 0 ? [...lines, `and ${more} more`] : lines
    };
  });
}

interface WindowCounts {
  failedLoginsByIp: { sourceIp: string; count: number }[];
  deniedTotal: number;
}

async function windowCounts(executor: SqlExecutor): Promise<WindowCounts> {
  const failed = await executor.execute(sql`
    SELECT COALESCE(source_ip, 'unknown') AS source_ip, count(*)::int AS n
    FROM security_events
    WHERE occurred_at > now() - make_interval(mins => ${WINDOW_MINUTES})
      AND action = 'http.security_mutation'
      AND resource_id = 'POST /api/auth/login'
      AND outcome = 'denied'
    GROUP BY 1
  `);
  const denied = await executor.execute(sql`
    SELECT count(*)::int AS n
    FROM security_events
    WHERE occurred_at > now() - make_interval(mins => ${WINDOW_MINUTES})
      AND outcome = 'denied'
  `);
  return {
    failedLoginsByIp: failed.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return { sourceIp: String(r["source_ip"]), count: Number(r["n"]) };
    }),
    deniedTotal: Number((denied.rows[0] as Record<string, unknown> | undefined)?.["n"] ?? 0)
  };
}

/** Window rules. Each key alerts at most once an hour per process. */
export function windowAlerts(
  counts: WindowCounts,
  cooldowns: Map<string, number>,
  nowMs: number
): { alerts: SecurityAlert[]; keys: string[] } {
  const alerts: SecurityAlert[] = [];
  const keys: string[] = [];
  const cooling = (key: string) =>
    nowMs - (cooldowns.get(key) ?? 0) < WINDOW_COOLDOWN_MS;

  for (const { sourceIp, count } of counts.failedLoginsByIp) {
    const key = `failed_logins_ip:${sourceIp}`;
    if (count < FAILED_LOGINS_PER_IP || cooling(key)) continue;
    keys.push(key);
    alerts.push({
      rule: "failed_logins_ip",
      summary: `Repeated failed logins from ${sourceIp}`,
      lines: [`${count} denied POST /api/auth/login in the last ${WINDOW_MINUTES} minutes (threshold ${FAILED_LOGINS_PER_IP})`]
    });
  }
  const failedTotal = counts.failedLoginsByIp.reduce((sum, row) => sum + row.count, 0);
  if (failedTotal >= FAILED_LOGINS_TOTAL && !cooling("failed_logins_total")) {
    keys.push("failed_logins_total");
    alerts.push({
      rule: "failed_logins_total",
      summary: "Failed login spike",
      lines: [
        `${failedTotal} denied logins from ${counts.failedLoginsByIp.length} addresses in the last ${WINDOW_MINUTES} minutes (threshold ${FAILED_LOGINS_TOTAL})`
      ]
    });
  }
  if (counts.deniedTotal >= DENIED_TOTAL && !cooling("denied_spike")) {
    keys.push("denied_spike");
    alerts.push({
      rule: "denied_spike",
      summary: "Denied request spike",
      lines: [
        `${counts.deniedTotal} denied security events in the last ${WINDOW_MINUTES} minutes (threshold ${DENIED_TOTAL})`
      ]
    });
  }
  return { alerts, keys };
}

async function runPass(
  executor: SqlExecutor,
  cooldowns: Map<string, number>,
  now: () => number
): Promise<void> {
  const cursorResult = await executor.execute(sql`
    SELECT last_sequence FROM security_monitor_state WHERE id
  `);
  const cursorRow = cursorResult.rows[0] as { last_sequence?: unknown } | undefined;
  const lastSequence = cursorRow ? Number(cursorRow.last_sequence) : 0;

  const result = await executor.execute(sql`
    SELECT sequence, id::text, occurred_at, action, outcome,
           actor_user_id::text, actor_email, actor_role, program_id::text,
           resource_type, resource_id, request_id, source_ip, details, event_hash
    FROM security_events
    WHERE sequence > ${lastSequence}
    ORDER BY sequence
    LIMIT ${BATCH_SIZE}
  `);
  const events = result.rows.map((row) => toEvent(row as Record<string, unknown>));
  for (const event of events) logJsonLine("[security-event]", event);

  const nowMs = now();
  const windows = windowAlerts(await windowCounts(executor), cooldowns, nowMs);
  const alerts = [...eventAlerts(events, nowMs), ...windows.alerts];
  if (!(await deliverSecurityAlerts(alerts))) {
    throw new Error("alert email failed; the batch will be retried");
  }
  for (const key of windows.keys) cooldowns.set(key, nowMs);

  const newest = events[events.length - 1];
  if (newest) {
    await executor.execute(sql`
      INSERT INTO security_monitor_state (id, last_sequence, updated_at)
      VALUES (true, ${newest.sequence}, now())
      ON CONFLICT (id) DO UPDATE
      SET last_sequence = GREATEST(security_monitor_state.last_sequence, EXCLUDED.last_sequence),
          updated_at = now()
    `);
  }
}

export function startSecurityMonitor(
  executor: SqlExecutor = db as unknown as SqlExecutor,
  now: () => number = Date.now
): () => void {
  const cooldowns = new Map<string, number>();
  let running = false;
  let stopped = false;
  let failedPasses = 0;
  let failureAlerted = false;
  let lastError = "";

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      // One pass at a time across processes: during a deploy the old and new
      // worker overlap briefly, and both would otherwise email the same batch.
      await withPgAdvisoryLock(LOCK_KEY, () => runPass(executor, cooldowns, now));
      failedPasses = 0;
      failureAlerted = false;
      lastError = "";
    } catch (error) {
      failedPasses += 1;
      const message = safeErrorMessage(error);
      if (message !== lastError) {
        console.error("[security-monitor] pass failed:", message);
        lastError = message;
      }
      if (failedPasses >= FAILED_PASSES_BEFORE_ALERT && !failureAlerted) {
        failureAlerted = await deliverSecurityAlerts([
          {
            rule: "security_monitor_failing",
            summary: "Security monitor is failing",
            lines: [
              `${failedPasses} consecutive passes failed; security events are not being exported or checked.`,
              `Last error: ${message.slice(0, 300)}`
            ]
          }
        ]);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
