import { describe, expect, it } from "vitest";
import {
  createHighlightSchema,
  updateHighlightSchema
} from "../kb-highlights.js";

const validHighlight = {
  documentVersionId: "b60c8d5f-ff83-4516-b283-208b6b5ac2d0",
  highlightedText: "Exact policy text",
  startOffset: 10,
  endOffset: 27,
  color: "yellow"
};

describe("KB highlight validation", () => {
  it("accepts a version-anchored exact range", () => {
    expect(createHighlightSchema.safeParse(validHighlight).success).toBe(true);
  });

  it("uses UTF-16 range length for emoji", () => {
    expect(
      createHighlightSchema.safeParse({
        ...validHighlight,
        highlightedText: "😀",
        startOffset: 2,
        endOffset: 4
      }).success
    ).toBe(true);
  });

  it("rejects invalid offsets, quote lengths, and whitespace-only text", () => {
    expect(
      createHighlightSchema.safeParse({
        ...validHighlight,
        endOffset: validHighlight.startOffset
      }).success
    ).toBe(false);
    expect(
      createHighlightSchema.safeParse({
        ...validHighlight,
        endOffset: validHighlight.endOffset + 1
      }).success
    ).toBe(false);
    expect(
      createHighlightSchema.safeParse({
        ...validHighlight,
        highlightedText: "   ",
        endOffset: validHighlight.startOffset + 3
      }).success
    ).toBe(false);
    expect(
      createHighlightSchema.safeParse({
        ...validHighlight,
        startOffset: 2_147_483_648,
        endOffset: 2_147_483_665
      }).success
    ).toBe(false);
  });

  it("rejects arbitrary colors and extra update fields", () => {
    expect(updateHighlightSchema.safeParse({ color: "#ffffff" }).success).toBe(
      false
    );
    expect(
      updateHighlightSchema.safeParse({ color: "blue", userId: "someone-else" })
        .success
    ).toBe(false);
  });
});
