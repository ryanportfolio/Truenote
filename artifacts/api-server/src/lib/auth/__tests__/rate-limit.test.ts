import type { Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIpFrom, SlidingWindowLimiter } from "../rate-limit.js";

function request(headers: Record<string, string>, ip = "100.64.0.9"): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { ip, header: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
}

// POAM-2026-027: the address comes from the X-Real-IP header Railway's edge
// sets, never from client-supplied X-Forwarded-For entries.
describe("clientIpFrom", () => {
  it("ignores a spoofed first X-Forwarded-For entry", () => {
    const real = { "X-Real-IP": "203.0.113.50" };
    const honest = clientIpFrom(request({ ...real, "X-Forwarded-For": "203.0.113.50" }));
    const spoofed = clientIpFrom(request({ ...real, "X-Forwarded-For": "198.51.100.1, 203.0.113.50" }));
    const otherSpoof = clientIpFrom(request({ ...real, "X-Forwarded-For": "10.0.0.1, 192.0.2.7, 203.0.113.50" }));
    expect(honest).toBe("203.0.113.50");
    expect(spoofed).toBe("203.0.113.50");
    expect(otherSpoof).toBe("203.0.113.50");
  });

  it("does not take X-Forwarded-For when X-Real-IP is absent", () => {
    expect(clientIpFrom(request({ "X-Forwarded-For": "198.51.100.1" }, "127.0.0.1"))).toBe("127.0.0.1");
  });

  it("trims the X-Real-IP value and falls back to the socket address when it is blank", () => {
    expect(clientIpFrom(request({ "X-Real-IP": " 2001:db8::1 " }))).toBe("2001:db8::1");
    expect(clientIpFrom(request({ "X-Real-IP": "  " }, "127.0.0.1"))).toBe("127.0.0.1");
  });
});

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
