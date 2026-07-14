import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  processSiemDeliveryBatch,
  resolveSiemConfig,
  retryDelayMs,
  sendSecurityEvent,
  type ClaimedSiemDelivery,
  type SiemDeliveryStore,
} from "../siem-outbox.js";

function delivery(attempts = 1): ClaimedSiemDelivery {
  return {
    leaseToken: "11111111-1111-4111-8111-111111111111",
    attempts,
    event: {
      id: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-14T12:00:00.000Z",
      eventHash: "event-hash",
      action: "document.approve",
      outcome: "success",
      actorUserId: "33333333-3333-4333-8333-333333333333",
      actorEmail: "reviewer@example.com",
      actorRole: "senior_manager",
      programId: "44444444-4444-4444-8444-444444444444",
      resourceType: "document_version",
      resourceId: "version-1",
      requestId: "request-1",
      sourceIp: "203.0.113.10",
      details: { reviewed: true },
    },
  };
}

function storeFor(items: ClaimedSiemDelivery[]) {
  const delivered: string[] = [];
  const failures: Array<{
    eventId: string;
    deadLetter: boolean;
    nextAttemptAt: Date;
  }> = [];
  const store: SiemDeliveryStore = {
    claim: vi.fn(async () => items),
    complete: vi.fn(async (item) => {
      delivered.push(item.event.id);
      return true;
    }),
    fail: vi.fn(async (item, failure) => {
      failures.push({ eventId: item.event.id, ...failure });
      return true;
    }),
  };
  return { store, delivered, failures };
}

describe("SIEM outbox delivery", () => {
  const signingKey = "s".repeat(32);

  it("requires URL and signing key, and enforces HTTPS in production", () => {
    expect(resolveSiemConfig({ NODE_ENV: "production" }).enabled).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "https://siem.example/events",
      }).enabled,
    ).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "http://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      }).enabled,
    ).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "not-a-url",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      }).enabled,
    ).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "https://user:password@siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      }).enabled,
    ).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "https://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: "too-short",
      }).enabled,
    ).toBe(false);
    expect(
      resolveSiemConfig({
        NODE_ENV: "production",
        SIEM_WEBHOOK_URL: "https://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      }).enabled,
    ).toBe(true);
  });

  it("signs the exact body and sends an idempotency event id", async () => {
    const item = delivery();
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    await sendSecurityEvent(
      item.event,
      { url: "https://siem.example/events", signingKey: "secret" },
      fetchImpl,
    );

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://siem.example/events");
    const body = String(init?.body);
    expect(body).toBe(JSON.stringify(item.event));
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Truenote-Event-Id": item.event.id,
      "X-Truenote-Signature": `sha256=${createHmac("sha256", "secret")
        .update(body)
        .digest("hex")}`,
    });
  });

  it("does not claim rows while delivery is unconfigured", async () => {
    const { store } = storeFor([delivery()]);
    const result = await processSiemDeliveryBatch({
      env: {},
      store,
      send: vi.fn(),
    });
    expect(result).toEqual({
      configured: false,
      claimed: 0,
      delivered: 0,
      retried: 0,
      deadLettered: 0,
      staleLeases: 0,
    });
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("retries transient failures with bounded exponential backoff", async () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    const { store, failures } = storeFor([delivery(2)]);
    const result = await processSiemDeliveryBatch({
      env: {
        SIEM_WEBHOOK_URL: "https://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      },
      store,
      now: () => now,
      send: vi.fn(async () => {
        throw new Error("HTTP 503");
      }),
    });
    expect(result.retried).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect(failures).toEqual([
      {
        eventId: delivery().event.id,
        error: "HTTP 503",
        deadLetter: false,
        nextAttemptAt: new Date(now.getTime() + retryDelayMs(2)),
      },
    ]);
  });

  it("dead-letters after the configured maximum attempt", async () => {
    const { store, failures } = storeFor([delivery(8)]);
    const result = await processSiemDeliveryBatch({
      env: {
        SIEM_WEBHOOK_URL: "https://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
        SIEM_DELIVERY_MAX_ATTEMPTS: "8",
      },
      store,
      send: vi.fn(async () => {
        throw new Error("receiver unavailable");
      }),
    });
    expect(result.deadLettered).toBe(1);
    expect(failures[0]?.deadLetter).toBe(true);
  });

  it("marks a successful delivery complete", async () => {
    const { store, delivered } = storeFor([delivery()]);
    const result = await processSiemDeliveryBatch({
      env: {
        SIEM_WEBHOOK_URL: "https://siem.example/events",
        SIEM_WEBHOOK_SIGNING_KEY: signingKey,
      },
      store,
      send: vi.fn(async () => undefined),
    });
    expect(result.delivered).toBe(1);
    expect(delivered).toEqual([delivery().event.id]);
    expect(store.claim).toHaveBeenCalledWith(25, 60);
  });

  it("ships transactional, lease-fenced Replit-ready DDL", async () => {
    const ddlPath = fileURLToPath(
      new URL(
        "../../../../../../docs/security/p1-siem-delivery-outbox.sql",
        import.meta.url,
      ),
    );
    const ddl = await readFile(ddlPath, "utf8");
    expect(ddl.trimStart()).toContain("BEGIN;");
    expect(ddl).toContain("CREATE TRIGGER security_events_siem_enqueue");
    expect(ddl).toContain("claim_siem_deliveries");
    expect(ddl).toContain("FOR UPDATE OF outbox SKIP LOCKED");
    expect(ddl).toContain("complete_siem_delivery");
    expect(ddl).toContain("fail_siem_delivery");
    expect(ddl).toContain("get_siem_delivery_health");
    expect(ddl).toContain("COMMIT;");
    expect(ddl).not.toMatch(/DROP\s+TABLE/i);
  });
});
