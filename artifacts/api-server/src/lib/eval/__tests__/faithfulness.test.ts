import { describe, expect, it } from "vitest";
import { scoreClaims } from "../faithfulness.js";
import { expectedDocRank } from "../runner.js";

describe("scoreClaims", () => {
  it("computes the supported percentage and lists unsupported claims", () => {
    const result = scoreClaims([
      { claim: "The fee is $25", supported: true },
      { claim: "Refunds take 5 days", supported: false },
      { claim: "Plan X includes voicemail", supported: true },
      { claim: "The deadline is March 1", supported: false }
    ]);
    expect(result.faithfulnessPct).toBe(50);
    expect(result.unsupportedClaims).toEqual([
      "Refunds take 5 days",
      "The deadline is March 1"
    ]);
  });

  it("returns null pct for an answer with no factual claims", () => {
    const result = scoreClaims([]);
    expect(result.faithfulnessPct).toBeNull();
    expect(result.unsupportedClaims).toEqual([]);
  });

  it("scores a fully supported answer at 100", () => {
    const result = scoreClaims([{ claim: "a", supported: true }]);
    expect(result.faithfulnessPct).toBe(100);
    expect(result.unsupportedClaims).toEqual([]);
  });
});

describe("expectedDocRank", () => {
  const ranked = [
    { chunkId: "c1", documentId: "doc-a" },
    { chunkId: "c2", documentId: "doc-b" },
    { chunkId: "c3", documentId: "doc-a" },
    { chunkId: "c4", documentId: null }
  ];

  it("returns the 1-based rank of the first chunk from the expected doc", () => {
    expect(expectedDocRank(ranked, "doc-a")).toBe(1);
    expect(expectedDocRank(ranked, "doc-b")).toBe(2);
  });

  it("returns null when the expected doc is absent", () => {
    expect(expectedDocRank(ranked, "doc-z")).toBeNull();
    expect(expectedDocRank([], "doc-a")).toBeNull();
  });
});
