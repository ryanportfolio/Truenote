import type { LocalLoginMode } from "./oidc.js";

/**
 * Session time limits for SSO and restricted local sessions.
 *
 *   SESSION_IDLE_MINUTES   idle limit, default 15, allowed 5 to 480
 *   SSO_SESSION_MAX_HOURS  absolute limit of an oidc session, default 10,
 *                          allowed 1 to 24
 *
 * Same rule as MIN_PASSWORD_LENGTH in lib/config.ts: a missing value uses
 * the default; a non-integer or out-of-range value logs a warning and uses
 * the default. The env is re-read on every call (cheap) so tests and
 * operators see changes; the warning is logged once per distinct bad value.
 */
const IDLE_DEFAULT_MINUTES = 15;
const IDLE_MIN_MINUTES = 5;
const IDLE_MAX_MINUTES = 480;

const SSO_MAX_DEFAULT_HOURS = 10;
const SSO_MAX_MIN_HOURS = 1;
const SSO_MAX_MAX_HOURS = 24;

/**
 * Requests carrying this header with value "1" are background traffic
 * (polling, status refresh). They authenticate as usual but do not count
 * as activity, so they never keep an idle session alive.
 */
export const BACKGROUND_REQUEST_HEADER = "X-Truenote-Background";

const warned = new Map<string, string>();

function boundedInteger(
  name: string,
  fallback: number,
  floor: number,
  ceiling: number
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < floor || parsed > ceiling) {
    if (warned.get(name) !== raw) {
      warned.set(name, raw);
      console.warn(
        `[config] ${name} is out of range [${floor}, ${ceiling}]; ` +
          `using default ${fallback}.`
      );
    }
    return fallback;
  }
  return parsed;
}

export function getSessionIdleMinutes(): number {
  return boundedInteger(
    "SESSION_IDLE_MINUTES",
    IDLE_DEFAULT_MINUTES,
    IDLE_MIN_MINUTES,
    IDLE_MAX_MINUTES
  );
}

export function getSsoSessionMaxHours(): number {
  return boundedInteger(
    "SSO_SESSION_MAX_HOURS",
    SSO_MAX_DEFAULT_HOURS,
    SSO_MAX_MIN_HOURS,
    SSO_MAX_MAX_HOURS
  );
}

export function getSessionIdleMs(): number {
  return getSessionIdleMinutes() * 60 * 1000;
}

export function getSsoSessionMaxMs(): number {
  return getSsoSessionMaxHours() * 60 * 60 * 1000;
}

/**
 * Whether a session ends after the idle window. Every oidc session does.
 * A local session does only while LOCAL_LOGIN_MODE is not `enabled`, i.e.
 * when local login is the restricted emergency path.
 */
export function isIdleLimited(
  authMethod: string,
  localLoginMode: LocalLoginMode
): boolean {
  if (authMethod === "oidc") return true;
  return localLoginMode !== "enabled";
}

/** Whether a session last used at `lastUsedAt` has passed the idle window. */
export function isPastIdleWindow(
  lastUsedAt: Date,
  now: Date = new Date(),
  idleMs: number = getSessionIdleMs()
): boolean {
  return now.getTime() - lastUsedAt.getTime() > idleMs;
}

/** Test-only: forget which bad values were already warned about. */
export function resetSessionPolicyWarningsForTests(): void {
  warned.clear();
}
