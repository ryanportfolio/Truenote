/**
 * Read MIN_PASSWORD_LENGTH from env with a safe fallback. Centralized
 * here so every consumer (zod schema, error message, public config
 * endpoint) reads the same value at process start.
 *
 * Default and hard floor are 15 because local login is a single-factor
 * break-glass path. Shorter values are rejected even in development so
 * deployment behavior cannot silently weaken through configuration drift.
 *
 * The upper bound matches the password column's upstream zod max.
 */
const DEFAULT_MIN = 15;
const HARD_FLOOR = 15;
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
      `[config] MIN_PASSWORD_LENGTH is out of range ` +
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
