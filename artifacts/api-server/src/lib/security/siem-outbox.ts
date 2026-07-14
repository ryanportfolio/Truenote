import { createHmac } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import type { StoredSecurityEvent } from "./audit.js";
import { isMissingSecuritySchema } from "./errors.js";

export interface SiemConfig {
  url: string;
  signingKey: string;
}

export type SiemConfigResolution =
  | { enabled: true; config: SiemConfig; reason: null }
  | {
      enabled: false;
      config: null;
      reason:
        | "url_missing"
        | "url_invalid"
        | "signing_key_missing"
        | "signing_key_too_short"
        | "https_required";
    };

export interface ClaimedSiemDelivery {
  leaseToken: string;
  attempts: number;
  event: StoredSecurityEvent;
}

export interface SiemFailureDisposition {
  error: string;
  deadLetter: boolean;
  nextAttemptAt: Date;
}

export interface SiemDeliveryStore {
  claim(limit: number, leaseSeconds: number): Promise<ClaimedSiemDelivery[]>;
  complete(delivery: ClaimedSiemDelivery): Promise<boolean>;
  fail(
    delivery: ClaimedSiemDelivery,
    failure: SiemFailureDisposition,
  ): Promise<boolean>;
}

export interface SiemBatchResult {
  configured: boolean;
  claimed: number;
  delivered: number;
  retried: number;
  deadLettered: number;
  staleLeases: number;
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BASE_MS = 30_000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1000;
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_DELIVERY_SLO_SECONDS = 300;

function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function resolveSiemConfig(
  env: NodeJS.ProcessEnv = process.env,
): SiemConfigResolution {
  const url = env.SIEM_WEBHOOK_URL?.trim();
  if (!url) return { enabled: false, config: null, reason: "url_missing" };
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { enabled: false, config: null, reason: "url_invalid" };
  }
  if (
    (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") ||
    parsedUrl.username !== "" ||
    parsedUrl.password !== ""
  ) {
    return { enabled: false, config: null, reason: "url_invalid" };
  }
  const signingKey = env.SIEM_WEBHOOK_SIGNING_KEY?.trim();
  if (!signingKey) {
    return { enabled: false, config: null, reason: "signing_key_missing" };
  }
  if (signingKey.length < 32) {
    return { enabled: false, config: null, reason: "signing_key_too_short" };
  }
  if (env.NODE_ENV === "production" && parsedUrl.protocol !== "https:") {
    return { enabled: false, config: null, reason: "https_required" };
  }
  return {
    enabled: true,
    config: { url: parsedUrl.href, signingKey },
    reason: null,
  };
}

export async function sendSecurityEvent(
  event: StoredSecurityEvent,
  config: SiemConfig,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const body = JSON.stringify(event);
  const signature = createHmac("sha256", config.signingKey)
    .update(body)
    .digest("hex");
  const response = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Truenote-Signature": `sha256=${signature}`,
      "X-Truenote-Event-Id": event.id,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`SIEM webhook returned HTTP ${response.status}`);
  }
}

export function retryDelayMs(
  attempt: number,
  baseMs = DEFAULT_RETRY_BASE_MS,
  maxMs = DEFAULT_RETRY_MAX_MS,
): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(maxMs, baseMs * 2 ** exponent);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`claim_siem_deliveries returned invalid ${field}`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function eventOutcome(value: unknown): StoredSecurityEvent["outcome"] {
  if (value === "success" || value === "denied" || value === "failure") {
    return value;
  }
  throw new Error("claim_siem_deliveries returned invalid outcome");
}

function claimedDelivery(row: Record<string, unknown>): ClaimedSiemDelivery {
  const occurred = row["occurred_at"];
  const occurredAt =
    occurred instanceof Date
      ? occurred.toISOString()
      : stringValue(occurred, "occurred_at");
  const attempts = Number(row["attempts"]);
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("claim_siem_deliveries returned invalid attempts");
  }
  const details = row["details"];
  return {
    leaseToken: stringValue(row["lease_token"], "lease_token"),
    attempts,
    event: {
      id: stringValue(row["id"], "id"),
      occurredAt,
      eventHash: stringValue(row["event_hash"], "event_hash"),
      action: stringValue(row["action"], "action"),
      outcome: eventOutcome(row["outcome"]),
      actorUserId: nullableString(row["actor_user_id"]),
      actorEmail: nullableString(row["actor_email"]),
      actorRole: nullableString(row["actor_role"]),
      programId: nullableString(row["program_id"]),
      resourceType: nullableString(row["resource_type"]),
      resourceId: nullableString(row["resource_id"]),
      requestId: nullableString(row["request_id"]),
      sourceIp: nullableString(row["source_ip"]),
      details:
        typeof details === "object" && details !== null && !Array.isArray(details)
          ? (details as Record<string, unknown>)
          : {},
    },
  };
}

function createSqlStore(
  executor: SqlExecutor = db as unknown as SqlExecutor,
): SiemDeliveryStore {
  return {
    async claim(limit, leaseSeconds) {
      const result = await executor.execute(sql`
        SELECT *
        FROM claim_siem_deliveries(${limit}, ${leaseSeconds})
      `);
      return result.rows.map((row) =>
        claimedDelivery(row as Record<string, unknown>),
      );
    },
    async complete(delivery) {
      const result = await executor.execute(sql`
        SELECT complete_siem_delivery(
          ${delivery.event.id}::uuid,
          ${delivery.leaseToken}::uuid
        ) AS completed
      `);
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return row["completed"] === true;
    },
    async fail(delivery, failure) {
      const result = await executor.execute(sql`
        SELECT fail_siem_delivery(
          ${delivery.event.id}::uuid,
          ${delivery.leaseToken}::uuid,
          ${failure.error},
          ${failure.deadLetter},
          ${failure.nextAttemptAt}
        ) AS failed
      `);
      const row = (result.rows[0] ?? {}) as Record<string, unknown>;
      return row["failed"] === true;
    },
  };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2000);
}

export interface ProcessSiemBatchOptions {
  env?: NodeJS.ProcessEnv;
  store?: SiemDeliveryStore;
  send?: (event: StoredSecurityEvent, config: SiemConfig) => Promise<void>;
  now?: () => Date;
}

export async function processSiemDeliveryBatch(
  options: ProcessSiemBatchOptions = {},
): Promise<SiemBatchResult> {
  const env = options.env ?? process.env;
  const resolution = resolveSiemConfig(env);
  const summary: SiemBatchResult = {
    configured: resolution.enabled,
    claimed: 0,
    delivered: 0,
    retried: 0,
    deadLettered: 0,
    staleLeases: 0,
  };
  if (!resolution.enabled) return summary;

  const store = options.store ?? createSqlStore();
  const batchSize = boundedInt(
    env.SIEM_DELIVERY_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    100,
  );
  const concurrency = boundedInt(
    env.SIEM_DELIVERY_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    1,
    10,
  );
  // Each send has a five-second deadline. Keep the effective batch within a
  // lease that remains under the DDL's 300-second maximum, even at concurrency
  // one, then add ten seconds for database completion calls.
  const effectiveBatchSize = Math.min(batchSize, concurrency * 45);
  const minimumLeaseSeconds =
    Math.ceil(effectiveBatchSize / concurrency) * 6 + 10;
  const configuredLeaseSeconds = boundedInt(
    env.SIEM_DELIVERY_LEASE_SECONDS,
    DEFAULT_LEASE_SECONDS,
    5,
    300,
  );
  const leaseSeconds = Math.min(
    300,
    Math.max(configuredLeaseSeconds, minimumLeaseSeconds),
  );
  const maxAttempts = boundedInt(
    env.SIEM_DELIVERY_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    1,
    100,
  );
  const deliveries = await store.claim(effectiveBatchSize, leaseSeconds);
  summary.claimed = deliveries.length;

  let cursor = 0;
  const processNext = async (): Promise<void> => {
    const delivery = deliveries[cursor];
    cursor += 1;
    if (!delivery) return;
    try {
      if (options.send) {
        await options.send(delivery.event, resolution.config);
      } else {
        await sendSecurityEvent(delivery.event, resolution.config);
      }
      if (await store.complete(delivery)) summary.delivered += 1;
      else summary.staleLeases += 1;
    } catch (error) {
      const deadLetter = delivery.attempts >= maxAttempts;
      const nextAttemptAt = new Date(
        (options.now?.() ?? new Date()).getTime() + retryDelayMs(delivery.attempts),
      );
      const updated = await store.fail(delivery, {
        error: errorMessage(error),
        deadLetter,
        nextAttemptAt,
      });
      if (!updated) {
        summary.staleLeases += 1;
      } else if (deadLetter) {
        summary.deadLettered += 1;
        console.error(
          `[security-audit] SIEM delivery dead-lettered: ${delivery.event.id}`,
        );
      } else {
        summary.retried += 1;
      }
    }
    await processNext();
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, deliveries.length) },
      () => processNext(),
    ),
  );
  return summary;
}

export function startSiemOutboxWorker(
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const pollMs = boundedInt(
    env.SIEM_DELIVERY_POLL_MS,
    DEFAULT_POLL_MS,
    1_000,
    5 * 60 * 1000,
  );
  let running = false;
  let stopped = false;
  let lastError = "";

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await processSiemDeliveryBatch({ env });
      if (result.configured && result.claimed > 0) {
        console.log(
          `[security-audit] SIEM batch: claimed=${result.claimed} delivered=${result.delivered} retried=${result.retried} deadLettered=${result.deadLettered} staleLeases=${result.staleLeases}`,
        );
      }
      lastError = "";
    } catch (error) {
      const message = errorMessage(error);
      if (message !== lastError) {
        console.error("[security-audit] SIEM outbox worker failed:", message);
        lastError = message;
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), pollMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface SiemDeliveryHealth {
  storageReady: boolean;
  deliveryConfigured: boolean;
  configurationIssue: SiemConfigResolution["reason"];
  healthy: boolean;
  pending: number;
  delivering: number;
  delivered: number;
  deadLetter: number;
  oldestPendingAt: string | null;
  lastDeliveredAt: string | null;
}

function isoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export async function getSiemDeliveryHealth(
  env: NodeJS.ProcessEnv = process.env,
  executor: SqlExecutor = db as unknown as SqlExecutor,
): Promise<SiemDeliveryHealth> {
  const resolution = resolveSiemConfig(env);
  try {
    const result = await executor.execute(sql`
      SELECT * FROM get_siem_delivery_health()
    `);
    const row = (result.rows[0] ?? {}) as Record<string, unknown>;
    const pending = Number(row["pending_count"] ?? 0);
    const delivering = Number(row["delivering_count"] ?? 0);
    const delivered = Number(row["delivered_count"] ?? 0);
    const deadLetter = Number(row["dead_letter_count"] ?? 0);
    const oldestPendingAt = isoString(row["oldest_pending_at"]);
    const lastDeliveredAt = isoString(row["last_delivered_at"]);
    const sloSeconds = boundedInt(
      env.SIEM_DELIVERY_SLO_SECONDS,
      DEFAULT_DELIVERY_SLO_SECONDS,
      30,
      24 * 60 * 60,
    );
    const backlogWithinSlo =
      oldestPendingAt === null ||
      Date.now() - new Date(oldestPendingAt).getTime() <= sloSeconds * 1000;
    return {
      storageReady: true,
      deliveryConfigured: resolution.enabled,
      configurationIssue: resolution.reason,
      healthy: resolution.enabled && deadLetter === 0 && backlogWithinSlo,
      pending,
      delivering,
      delivered,
      deadLetter,
      oldestPendingAt,
      lastDeliveredAt,
    };
  } catch (error) {
    if (!isMissingSecuritySchema(error)) throw error;
    return {
      storageReady: false,
      deliveryConfigured: resolution.enabled,
      configurationIssue: resolution.reason,
      healthy: false,
      pending: 0,
      delivering: 0,
      delivered: 0,
      deadLetter: 0,
      oldestPendingAt: null,
      lastDeliveredAt: null,
    };
  }
}
