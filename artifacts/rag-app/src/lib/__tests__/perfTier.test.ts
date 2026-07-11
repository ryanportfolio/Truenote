import { describe, expect, it } from "vitest";
import { resolveIsLite } from "../perfTier";

describe("resolveIsLite", () => {
  it("mobile pins lite over every tier, including explicit full", () => {
    expect(resolveIsLite("auto", false, true)).toBe(true);
    expect(resolveIsLite("full", false, true)).toBe(true);
    expect(resolveIsLite("lite", false, true)).toBe(true);
  });

  it("explicit lite is always lite", () => {
    expect(resolveIsLite("lite", false, false)).toBe(true);
  });

  it("explicit full is never auto-downgraded", () => {
    expect(resolveIsLite("full", true, false)).toBe(false);
  });

  it("auto follows the downgrade latch", () => {
    expect(resolveIsLite("auto", false, false)).toBe(false);
    expect(resolveIsLite("auto", true, false)).toBe(true);
  });
});
