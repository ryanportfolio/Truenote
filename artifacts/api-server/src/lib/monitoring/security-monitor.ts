import { sql, type SQL } from "drizzle-orm";
import { db, withPgAdvisoryLock } from "../db-client.js";
import { isMissingSecuritySchema } from "../security/errors.js";
import {
  deliverSecurityAlerts,
  logJsonLine,
  rootErrorMessage,
  withDeadline,
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
const PASS_DEADLINE_MS = 120_000;

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

// Express routes case-insensitively and ignores a trailing slash, and the
// audit middleware keeps the request's spelling after the mount base, so
// route ids are compared case-insensitively here and in windowCounts.
const ACCOUNT_ROUTE = /^(POST|PUT|PATCH|DELETE) \/api\/admin\/users(\/|$)/i;

/**
 * Accounts whose ordinary super user logins do not alert
 * (SECURITY_ALERT_QUIET_LOGINS, comma-separated emails): the agent account
 * logs in many times a day. Their break-glass logins and every other rule
 * still alert, and their events are still printed.
 */
export function quietLoginEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.SECURITY_ALERT_QUIET_LOGINS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.includes("@"))
  );
}

/** The single-event rules. Returns null when the event raises no alert. */
export function eventAlertRule(
  event: MonitoredEvent,
  quietLogins: ReadonlySet<string> = new Set()
): { rule: string; summary: string } | null {
  if (event.action === "auth.break_glass.login") {
    return { rule: "break_glass_login", summary: "Break-glass login" };
  }
  if (
    (event.action === "auth.local.login" || event.action === "auth.oidc.login") &&
    event.outcome === "success" &&
    event.actorRole === "super_user"
  ) {
    if (quietLogins.has((event.actorEmail ?? "").toLowerCase())) return null;
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

/**
 * `alertSinceMs` is one hour before the cursor last advanced (or before now,
 * on the first pass). Older rows are history being caught up. Anchoring to
 * the cursor rather than the clock keeps a batch alertable while its email
 * keeps failing, and alerts on events from a worker outage once it restarts.
 */
export function eventAlerts(
  events: MonitoredEvent[],
  alertSinceMs: number,
  quietLogins: ReadonlySet<string> = new Set()
): SecurityAlert[] {
  const byRule = new Map<string, { summary: string; events: MonitoredEvent[] }>();
  for (const event of events) {
    if (new Date(event.occurredAt).getTime() < alertSinceMs) continue;
    const match = eventAlertRule(event, quietLogins);
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
      AND lower(rtrim(resource_id, '/')) = 'post /api/auth/login'
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
    SELECT last_sequence, updated_at FROM security_monitor_state WHERE id
  `);
  const cursorRow = cursorResult.rows[0] as
    | { last_sequence?: unknown; updated_at?: unknown }
    | undefined;
  const lastSequence = cursorRow ? Number(cursorRow.last_sequence) : 0;
  const advancedAtMs = cursorRow
    ? new Date(cursorRow.updated_at as string | Date).getTime()
    : now();

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
  const alertSinceMs = Math.min(nowMs, advancedAtMs) - ALERT_FRESHNESS_MS;
  const alerts = [
    ...eventAlerts(events, alertSinceMs, quietLoginEmails()),
    ...windows.alerts
  ];
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
      // The pool sets no query or connect timeout, so a pass that hangs is
      // abandoned at the deadline and counted as failed. It keeps its lock
      // until it ends, so later passes fail on the lock too and the failure
      // alert still fires.
      const locked = await withDeadline(
        withPgAdvisoryLock(LOCK_KEY, () => runPass(executor, cooldowns, now)),
        PASS_DEADLINE_MS,
        "security monitor pass"
      );
      if (!locked) {
        throw new Error("another security monitor pass holds the lock");
      }
      failedPasses = 0;
      failureAlerted = false;
      lastError = "";
    } catch (error) {
      failedPasses += 1;
      const message = rootErrorMessage(error);
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

export interface SecurityMonitorStatus {
  storageReady: boolean;
  lastSequence: number | null;
  latestSequence: number | null;
  pendingEvents: number | null;
  advancedAt: string | null;
  workerBeatAt: string | null;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(value as string | Date).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numberOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Super-user view of the monitor (GET /api/admin/observability/security-audit):
 * how far the cursor is behind the newest security event, when it last
 * advanced, and the worker's last heartbeat. storageReady is false until
 * lib/db/sql/0011 is applied.
 */
export async function getSecurityMonitorStatus(
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<SecurityMonitorStatus> {
  try {
    const result = await executor.execute(sql`
      SELECT
        (SELECT last_sequence FROM security_monitor_state WHERE id) AS last_sequence,
        (SELECT updated_at FROM security_monitor_state WHERE id) AS advanced_at,
        (SELECT max(sequence) FROM security_events) AS latest_sequence,
        -- Counted, not subtracted: a rolled-back insert leaves a gap in the
        -- sequence.
        (SELECT count(*)
           FROM security_events
          WHERE sequence > COALESCE(
            (SELECT last_sequence FROM security_monitor_state WHERE id), 0
          )) AS pending_events,
        (SELECT beat_at FROM service_heartbeats WHERE service = 'worker') AS worker_beat_at
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    return {
      storageReady: true,
      lastSequence: numberOrNull(row["last_sequence"]),
      latestSequence: numberOrNull(row["latest_sequence"]),
      pendingEvents: Number(row["pending_events"] ?? 0),
      advancedAt: isoOrNull(row["advanced_at"]),
      workerBeatAt: isoOrNull(row["worker_beat_at"])
    };
  } catch (error) {
    if (!isMissingSecuritySchema(error)) throw error;
    return {
      storageReady: false,
      lastSequence: null,
      latestSequence: null,
      pendingEvents: null,
      advancedAt: null,
      workerBeatAt: null
    };
  }
}
