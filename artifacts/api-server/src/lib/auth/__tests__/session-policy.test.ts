import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSessionIdleMinutes,
  getSessionIdleMs,
  getSsoSessionMaxHours,
  getSsoSessionMaxMs,
  isIdleLimited,
  isPastIdleWindow,
  resetSessionPolicyWarningsForTests
} from "../session-policy.js";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv("SESSION_IDLE_MINUTES", undefined);
  vi.stubEnv("SSO_SESSION_MAX_HOURS", undefined);
  resetSessionPolicyWarningsForTests();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  warnSpy.mockRestore();
});

describe("SESSION_IDLE_MINUTES", () => {
  it("defaults to 15 minutes", () => {
    expect(getSessionIdleMinutes()).toBe(15);
    expect(getSessionIdleMs()).toBe(15 * 60 * 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["5", "60", "480"])("accepts %s", (value) => {
    vi.stubEnv("SESSION_IDLE_MINUTES", value);
    expect(getSessionIdleMinutes()).toBe(Number(value));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["4", "481", "0", "-10", "abc", "15.5", "1e3"])(
    "falls back to 15 and warns for %s",
    (value) => {
      vi.stubEnv("SESSION_IDLE_MINUTES", value);
      expect(getSessionIdleMinutes()).toBe(15);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SESSION_IDLE_MINUTES is out of range [5, 480]")
      );
    }
  );
});

describe("SSO_SESSION_MAX_HOURS", () => {
  it("defaults to 10 hours", () => {
    expect(getSsoSessionMaxHours()).toBe(10);
    expect(getSsoSessionMaxMs()).toBe(10 * 60 * 60 * 1000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["1", "12", "24"])("accepts %s", (value) => {
    vi.stubEnv("SSO_SESSION_MAX_HOURS", value);
    expect(getSsoSessionMaxHours()).toBe(Number(value));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each(["0", "25", "-1", "ten", "2.5"])("falls back to 10 and warns for %s", (value) => {
    vi.stubEnv("SSO_SESSION_MAX_HOURS", value);
    expect(getSsoSessionMaxHours()).toBe(10);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("SSO_SESSION_MAX_HOURS is out of range [1, 24]")
    );
  });
});

describe("isIdleLimited", () => {
  it.each(["enabled", "break_glass", "disabled"] as const)(
    "limits every oidc session (mode %s)",
    (mode) => {
      expect(isIdleLimited("oidc", mode)).toBe(true);
    }
  );

  it("does not limit local sessions while LOCAL_LOGIN_MODE is enabled", () => {
    expect(isIdleLimited("local", "enabled")).toBe(false);
  });

  it.each(["break_glass", "disabled"] as const)("limits local sessions in %s", (mode) => {
    expect(isIdleLimited("local", mode)).toBe(true);
  });
});

describe("isPastIdleWindow", () => {
  const now = new Date("2026-10-10T12:00:00Z");
  const idleMs = 15 * 60 * 1000;

  it("is false inside the window and at its edge", () => {
    expect(isPastIdleWindow(new Date(now.getTime() - 60_000), now, idleMs)).toBe(false);
    expect(isPastIdleWindow(new Date(now.getTime() - idleMs), now, idleMs)).toBe(false);
  });

  it("is true once the window has passed", () => {
    expect(isPastIdleWindow(new Date(now.getTime() - idleMs - 1), now, idleMs)).toBe(true);
  });
});
