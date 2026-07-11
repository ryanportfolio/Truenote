import { describe, expect, it } from "vitest";
import { canServeKbVersion, parseCitationSourceIndex } from "../kb.js";

describe("parseCitationSourceIndex", () => {
  it("accepts canonical zero-based positions", () => {
    expect(parseCitationSourceIndex("0")).toBe(0);
    expect(parseCitationSourceIndex("7")).toBe(7);
    expect(parseCitationSourceIndex("63")).toBe(63);
  });

  it("rejects arrays, signs, leading zeroes, fractions, and oversized positions", () => {
    expect(parseCitationSourceIndex(["0"])).toBeNull();
    expect(parseCitationSourceIndex("+1")).toBeNull();
    expect(parseCitationSourceIndex("01")).toBeNull();
    expect(parseCitationSourceIndex("1.5")).toBeNull();
    expect(parseCitationSourceIndex("64")).toBeNull();
  });
});

describe("canServeKbVersion", () => {
  it("keeps current versions readable but gates inactive history on a receipt", () => {
    expect(canServeKbVersion(true, false)).toBe(true);
    expect(canServeKbVersion(false, true)).toBe(true);
    expect(canServeKbVersion(false, false)).toBe(false);
  });
});
