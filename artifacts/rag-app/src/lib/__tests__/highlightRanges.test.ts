import { describe, expect, it } from "vitest";
import {
  rangeMatchesText,
  rangesOverlap,
  trimSelectedRange
} from "../highlightRanges";

describe("highlight ranges", () => {
  it("trims selection whitespace without shifting the saved quote", () => {
    expect(trimSelectedRange("  exact passage\n", 10)).toEqual({
      highlightedText: "exact passage",
      startOffset: 12,
      endOffset: 25
    });
  });

  it("rejects whitespace-only selections", () => {
    expect(trimSelectedRange(" \n\t", 3)).toBeNull();
  });

  it("treats touching ranges as separate but detects real overlap", () => {
    expect(
      rangesOverlap(
        { startOffset: 0, endOffset: 5 },
        { startOffset: 5, endOffset: 9 }
      )
    ).toBe(false);
    expect(
      rangesOverlap(
        { startOffset: 0, endOffset: 5 },
        { startOffset: 4, endOffset: 9 }
      )
    ).toBe(true);
  });

  it("requires the saved quote to match the current rendered text", () => {
    const content = "Read the exact passage here.";
    expect(
      rangeMatchesText(content, {
        highlightedText: "exact passage",
        startOffset: 9,
        endOffset: 22
      })
    ).toBe(true);
    expect(
      rangeMatchesText(content, {
        highlightedText: "stale passage",
        startOffset: 9,
        endOffset: 22
      })
    ).toBe(false);
  });

  it("keeps DOM offsets in UTF-16 code units for emoji selections", () => {
    const content = "A 😀 policy";
    expect(
      rangeMatchesText(content, {
        highlightedText: "😀",
        startOffset: 2,
        endOffset: 4
      })
    ).toBe(true);
  });
});
