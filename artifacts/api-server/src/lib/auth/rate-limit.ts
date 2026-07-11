/**
 * Lightweight in-memory rate limiter for unauthenticated endpoints.
 *
 * Scope: single-process. Replit's standard deploy runs a single
 * api-server process so this is sufficient; if we ever scale
 * horizontally, swap to a Redis-backed counter (the API here is
 * deliberately small to make that swap one file).
 *
 * Two windows we care about for `POST /api/auth/forgot-password`:
 *   - per-IP: caps the request rate from one source. Bounces spammers
 *     who want to use us as a free relay for emails to arbitrary
 *     addresses. Surfaces as 429.
 *   - per-email: caps how many resets we'll send for a given email
 *     in a window, regardless of source IP. Stops a distributed
 *     spam campaign from filling a victim's inbox. Surfaces as
 *     silent suppression (still 204) so the per-email window
 *     doesn't leak which addresses are in flight.
 *
 * The differing posture (429 vs silent) is intentional: per-IP is the
 * actor's own attribute, so telling them about it gives them no
 * information they didn't already have. Per-email is the victim's
 * attribute — leaking "this email is currently in a reset flow"
 * would re-open the enumeration channel `forgot-password` is
 * already careful to close.
 */

interface Bucket {
  /** Timestamps (ms) of recent hits within the window. */
  hits: number[];
}

export interface RateLimiterOptions {
  /** Max hits allowed in `windowMs`. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

/**
 * Sliding-window counter. Memory-bounded by `maxKeys` so a flood of
 * distinct keys (e.g., spoofed IPs) can't OOM the process; oldest
 * keys are evicted when the cap is hit. The eviction is approximate
 * (insertion order, not LRU) — good enough for a defense layer.
 */
export class SlidingWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys = 10_000;

  constructor(private readonly options: RateLimiterOptions) {}

  /**
   * Returns true if the hit was accepted (under the cap); false if
   * the key is rate-limited.
   *
   * Only ACCEPTED hits are stored, which caps each key's array at
   * `limit` entries. An earlier version recorded denied hits too (to
   * keep a hammering caller locked while they flooded), but that let a
   * single key's array grow unbounded for the whole window under a
   * flood — heap pressure plus O(n) shift() cost when the window later
   * slid. Storing only accepted hits keeps the same "N per window"
   * guarantee with O(limit) memory: a flooder still gets exactly
   * `limit` through per window and the rest are cheaply rejected
   * without being remembered.
   */
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.options.windowMs;
    const bucket = this.buckets.get(key) ?? { hits: [] };
    // Drop hits older than the window. Cheap because the array holds at
    // most `limit` entries (only accepted hits are stored) and is in
    // insertion order — shift from the front.
    while (bucket.hits.length > 0 && (bucket.hits[0] ?? 0) < cutoff) {
      bucket.hits.shift();
    }
    const allowed = bucket.hits.length < this.options.limit;
    if (allowed) bucket.hits.push(now);
    if (!this.buckets.has(key)) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest insertion to bound memory.
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      this.buckets.set(key, bucket);
    } else {
      this.buckets.set(key, bucket);
    }
    return allowed;
  }

  /** Test hook — clear all buckets. */
  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Per-IP throttle: 5 requests per 10 minutes. Tight enough to deter
 * spam relay use, loose enough that an admin running through a
 * legitimate test flow (forgot pw, reset, forgot again because they
 * fat-fingered the new one) doesn't get locked out.
 */
export const forgotPasswordIpLimiter = new SlidingWindowLimiter({
  limit: 5,
  windowMs: 10 * 60 * 1000
});

/**
 * Per-email throttle: 3 sends per 10 minutes. A real user who keeps
 * mashing "forgot password" only generates one extra email per
 * window after the first, while a coordinated attempt to spam one
 * inbox bottoms out fast.
 */
export const forgotPasswordEmailLimiter = new SlidingWindowLimiter({
  limit: 3,
  windowMs: 10 * 60 * 1000
});

/**
 * Per-IP throttle for POST /api/auth/login. DELIBERATELY VERY GENEROUS:
 * a call center commonly puts many CSRs behind a single shared egress IP,
 * so this must never lock out a legitimate shift-change login burst
 * (dozens of people signing in, some fat-fingering a password, within a
 * couple of minutes). It exists only to blunt *unbounded* online password
 * guessing and the CPU cost of forced Argon2 verifications from one
 * source — NOT to be a precise brute-force control.
 *
 * We intentionally throttle per-IP only, never per-account: per-account
 * lockout would hand an attacker a denial-of-service (fail a victim's
 * logins on purpose to lock them out), which for a tool CSRs must reach
 * mid-call is worse than the guessing it would prevent.
 *
 * 2000 attempts / 10 min per IP caps a single source to ~3.3/s (Argon2
 * CPU well under one core) while sitting orders of magnitude above any
 * real office's login volume.
 */
export const loginIpLimiter = new SlidingWindowLimiter({
  limit: 2000,
  windowMs: 10 * 60 * 1000
});

/**
 * Best-effort client IP. Reads X-Forwarded-For first since Replit's
 * proxy sits in front of us; falls back to req.ip (Express's own
 * resolution) for direct-connection dev. Takes only the FIRST entry
 * in XFF — that's the originating client per the RFC; later entries
 * are intermediate proxies under varying levels of trust.
 *
 * In a header-untrusted environment an attacker can claim any IP by
 * forging XFF, evading the per-IP counter. The mitigation is the
 * per-email counter (silent suppression, independent of IP) and the
 * fact that Replit's proxy overwrites XFF with the real client
 * address. If we ever sit behind an untrusted proxy this needs to
 * change.
 */
export function clientIpFrom(req: import("express").Request): string {
  const xff = req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? "unknown";
}
