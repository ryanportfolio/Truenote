import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlidingWindowLimiter } from "../rate-limit.js";

describe("SlidingWindowLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit and denies beyond it within the window", () => {
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1000 });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
    expect(limiter.hit("k")).toBe(false);
  });

  it("slides the window: capacity returns after windowMs elapses", () => {
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
    vi.setSystemTime(1001);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
  });

  it("only remembers accepted hits, so denials don't consume future capacity", () => {
    // Regression guard for the memory fix: an earlier version stored
    // denied hits too, which grew a key's array without bound under a
    // flood AND stole capacity from the next window. With accepted-only
    // storage, a burst of denials mid-window leaves no residue once the
    // accepted hits age out.
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 1000 });
    expect(limiter.hit("k")).toBe(true); // t=0, stored
    expect(limiter.hit("k")).toBe(true); // t=0, stored
    vi.setSystemTime(500);
    expect(limiter.hit("k")).toBe(false); // denied — must NOT be stored
    expect(limiter.hit("k")).toBe(false); // denied — must NOT be stored
    vi.setSystemTime(1001); // the two t=0 accepted hits age out
    // Full capacity is back. Under the old bug the t=500 denials would
    // still occupy the bucket and steal a slot here (only 1 would pass).
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
  });

  it("tracks distinct keys independently", () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    expect(limiter.hit("b")).toBe(false);
  });

  it("reset() clears all buckets", () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 1000 });
    expect(limiter.hit("k")).toBe(true);
    expect(limiter.hit("k")).toBe(false);
    limiter.reset();
    expect(limiter.hit("k")).toBe(true);
  });
});
