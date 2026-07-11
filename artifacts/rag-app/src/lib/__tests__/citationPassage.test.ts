import { describe, expect, it } from "vitest";
import { markdownNodeIsCited } from "../citationPassage";

describe("markdownNodeIsCited", () => {
  const target = { excerpt: "passage", sourceStart: 10, sourceEnd: 30 };

  it("marks every structural node overlapping the exact source span", () => {
    expect(markdownNodeIsCited(0, 10, target)).toBe(false);
    expect(markdownNodeIsCited(9, 11, target)).toBe(true);
    expect(markdownNodeIsCited(20, 40, target)).toBe(true);
    expect(markdownNodeIsCited(30, 50, target)).toBe(false);
  });

  it("does not mark positionless nodes or a missing target", () => {
    expect(markdownNodeIsCited(undefined, 20, target)).toBe(false);
    expect(markdownNodeIsCited(10, 20, null)).toBe(false);
  });
});
