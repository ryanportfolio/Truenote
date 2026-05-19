/**
 * Read MIN_PASSWORD_LENGTH from env with a safe fallback. Centralized
 * here so every consumer (zod schema, error message, public config
 * endpoint) reads the same value at process start.
 *
 * Default is 3 — this is a dev/test-friendly floor. Tighten via the
 * env var for any real deployment; argon2's cost is mostly wasted on
 * 3-char inputs because the search space is trivial.
 *
 * The bound is clamped to [1, 1024] to match the password column's
 * upstream zod max — a misconfigured 0 would make every password pass
 * length validation (footgun); a huge value would break the form.
 */
const DEFAULT_MIN = 3;
const HARD_FLOOR = 1;
const HARD_CEILING = 1024;

let cached: number | null = null;

export function getMinPasswordLength(): number {
  if (cached !== null) return cached;
  const raw = process.env.MIN_PASSWORD_LENGTH;
  if (!raw) {
    cached = DEFAULT_MIN;
    return cached;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < HARD_FLOOR || parsed > HARD_CEILING) {
    console.warn(
      `[config] MIN_PASSWORD_LENGTH=${JSON.stringify(raw)} is out of range ` +
        `[${HARD_FLOOR}, ${HARD_CEILING}]; using default ${DEFAULT_MIN}.`
    );
    cached = DEFAULT_MIN;
    return cached;
  }
  cached = parsed;
  return cached;
}

/** Test-only escape hatch — clears the memoized value. */
export function resetMinPasswordLengthCacheForTests(): void {
  cached = null;
}
