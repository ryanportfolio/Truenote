import { describe, expect, it } from "vitest";
import {
  gatedTitle,
  normalizeFeedback,
  parseOptionalUuid,
  parseQuestionLimit,
  parseUsageWindowDays,
  takePage
} from "../source-usage.js";

describe("source usage query parsing", () => {
  it("clamps the window to 1..365 and falls back to 30", () => {
    expect(parseUsageWindowDays("7")).toBe(7);
    expect(parseUsageWindowDays("0")).toBe(1);
    expect(parseUsageWindowDays("9999")).toBe(365);
    expect(parseUsageWindowDays(undefined)).toBe(30);
    expect(parseUsageWindowDays("-5")).toBe(30);
    expect(parseUsageWindowDays(["7", "30"])).toBe(30);
  });

  it("clamps the question limit to 1..200 and falls back to 50", () => {
    expect(parseQuestionLimit("25")).toBe(25);
    expect(parseQuestionLimit("1000")).toBe(200);
    expect(parseQuestionLimit("abc")).toBe(50);
  });

  it("treats absent ids as no filter and malformed ids as invalid", () => {
    expect(parseOptionalUuid(undefined)).toBeNull();
    expect(parseOptionalUuid("")).toBeNull();
    expect(parseOptionalUuid("not-a-uuid")).toBe("invalid");
    expect(parseOptionalUuid(["a", "b"])).toBe("invalid");
    expect(parseOptionalUuid("B60C8D5F-FF83-4516-B283-208B6B5AC2D0")).toBe(
      "b60c8d5f-ff83-4516-b283-208b6b5ac2d0"
    );
  });
});

describe("source usage shaping", () => {
  it("hides titles above the viewer's clearance", () => {
    expect(gatedTitle("Refund eligibility", true)).toBe("Refund eligibility");
    expect(gatedTitle("Refund eligibility", false)).toBeNull();
  });

  it("keeps only 1 and -1 as feedback", () => {
    expect(normalizeFeedback(1)).toBe(1);
    expect(normalizeFeedback(-1)).toBe(-1);
    expect(normalizeFeedback(0)).toBeNull();
    expect(normalizeFeedback(null)).toBeNull();
  });

  it("splits a limit+1 fetch into a page and a truncated flag", () => {
    expect(takePage([1, 2, 3], 2)).toEqual({ items: [1, 2], truncated: true });
    expect(takePage([1, 2], 2)).toEqual({ items: [1, 2], truncated: false });
  });
});
