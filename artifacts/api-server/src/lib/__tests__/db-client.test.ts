import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withPgAdvisoryLockClient } from "../db-client.js";

function fakeClient(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return {
    client: { query, release } as unknown as Pick<PoolClient, "query" | "release">,
    release
  };
}

describe("withPgAdvisoryLockClient", () => {
  it("runs under the lock, unlocks, and returns a healthy client", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const { client, release } = fakeClient(query);
    const work = vi.fn().mockResolvedValue(undefined);

    await expect(withPgAdvisoryLockClient(client, "version:1", work)).resolves.toBe(
      true
    );
    expect(work).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(false);
  });

  it("reports contention without running work", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ locked: false }] });
    const { client, release } = fakeClient(query);
    const work = vi.fn();

    await expect(withPgAdvisoryLockClient(client, "version:1", work)).resolves.toBe(
      false
    );
    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(false);
  });

  it("destroys a client when lock acquisition fails", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("connection lost"));
    const { client, release } = fakeClient(query);

    await expect(
      withPgAdvisoryLockClient(client, "version:1", async () => undefined)
    ).rejects.toThrow("connection lost");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("destroys a client when unlock fails so a session lock cannot leak", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(new Error("unlock failed"));
    const { client, release } = fakeClient(query);

    await expect(
      withPgAdvisoryLockClient(client, "version:1", async () => undefined)
    ).resolves.toBe(true);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("unlocks before propagating a work failure", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockResolvedValueOnce({ rows: [{ pg_advisory_unlock: true }] });
    const { client, release } = fakeClient(query);

    await expect(
      withPgAdvisoryLockClient(client, "version:1", async () => {
        throw new Error("ingestion failed");
      })
    ).rejects.toThrow("ingestion failed");
    expect(query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(false);
  });
});
