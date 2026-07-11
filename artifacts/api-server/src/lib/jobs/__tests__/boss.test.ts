import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  constructed: 0,
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
  createQueue: vi.fn<() => Promise<void>>()
}));

vi.mock("pg-boss", () => ({
  default: class FakePgBoss {
    constructor() {
      fake.constructed += 1;
    }

    start = fake.start;
    stop = fake.stop;
    createQueue = fake.createQueue;
  }
}));

import { getBoss } from "../boss.js";

describe("shared pg-boss initialization", () => {
  beforeEach(() => {
    fake.constructed = 0;
    fake.start.mockReset();
    fake.stop.mockReset();
    fake.createQueue.mockReset();
    globalThis.__pgBoss = undefined;
    globalThis.__pgBossInit = undefined;
    process.env.DATABASE_URL = "postgres://example.invalid/test";
  });

  it("coalesces simultaneous first users onto one client", async () => {
    let release!: () => void;
    fake.start.mockImplementation(
      () => new Promise<void>((resolve) => {
        release = resolve;
      })
    );

    const first = getBoss();
    const second = getBoss();
    expect(fake.constructed).toBe(1);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fake.start).toHaveBeenCalledTimes(1);
  });

  it("clears a rejected initializer so a later request can recover", async () => {
    fake.start.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(getBoss()).rejects.toThrow("database unavailable");
    expect(globalThis.__pgBossInit).toBeUndefined();

    fake.start.mockResolvedValueOnce();
    await expect(getBoss()).resolves.toBeDefined();
    expect(fake.constructed).toBe(2);
  });
});
