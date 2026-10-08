import { describe, expect, it } from "vitest";
import {
  gatedTitle,
  normalizeFeedback,
  parseOptionalUuid,
  parseQuestionLimit,
  parseUsageWindowDays,
  selectSourceSuggestions,
  shapeUsageMatrix,
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

describe("source usage matrix", () => {
  it("gives every row one count per column, zero for missing cells", () => {
    expect(
      shapeUsageMatrix(
        ["doc-a", "doc-b"],
        [
          { userId: "u1", counts: [3, 1] },
          { userId: "u2", counts: [2] },
          { userId: "u3", counts: ["4", null, 9] }
        ]
      )
    ).toEqual({
      documentIds: ["doc-a", "doc-b"],
      rows: [
        { userId: "u1", counts: [3, 1] },
        { userId: "u2", counts: [2, 0] },
        { userId: "u3", counts: [4, 0] }
      ]
    });
  });

  it("returns empty columns and rows for an empty window", () => {
    expect(shapeUsageMatrix([], [])).toEqual({ documentIds: [], rows: [] });
    expect(shapeUsageMatrix(null, null)).toEqual({ documentIds: [], rows: [] });
  });

  it("keeps rows with no columns and drops rows without a user id", () => {
    expect(shapeUsageMatrix([], [{ userId: "u1", counts: [] }, { counts: [1] }, null])).toEqual({
      documentIds: [],
      rows: [{ userId: "u1", counts: [] }]
    });
  });
});

describe("source suggestions", () => {
  const base = { lastCitedAt: "2026-10-01T00:00:00.000Z", related: false };

  it("prefers related sources and ranks them by team citations", () => {
    expect(
      selectSourceSuggestions([
        { ...base, documentId: "top", title: "Billing overview", teamCitations: 40 },
        { ...base, documentId: "fees", title: "Fee schedule", teamCitations: 5, related: true },
        { ...base, documentId: "refunds", title: "Refund rules", teamCitations: 9, related: true }
      ])
    ).toEqual([
      { documentId: "refunds", title: "Refund rules", reason: "related", teamCitations: 9 },
      { documentId: "fees", title: "Fee schedule", reason: "related", teamCitations: 5 }
    ]);
  });

  it("falls back to the team's most cited sources when nothing is related", () => {
    expect(
      selectSourceSuggestions([
        { ...base, documentId: "a", title: "A", teamCitations: 3 },
        { ...base, documentId: "b", title: "B", teamCitations: 7 },
        { ...base, documentId: "c", title: "C", teamCitations: 4 },
        { ...base, documentId: "d", title: "D", teamCitations: 1 }
      ]).map((s) => [s.documentId, s.reason])
    ).toEqual([
      ["b", "team_top"],
      ["c", "team_top"],
      ["a", "team_top"]
    ]);
  });

  it("leaves out fallback sources with fewer than three team answers", () => {
    expect(
      selectSourceSuggestions([
        { ...base, documentId: "a", title: "A", teamCitations: 2 },
        { ...base, documentId: "b", title: "B", teamCitations: 3 }
      ]).map((s) => s.documentId)
    ).toEqual(["b"]);
  });

  it("returns at most three, breaking ties by recency then id", () => {
    const picked = selectSourceSuggestions([
      { ...base, documentId: "z", title: "Z", teamCitations: 3, related: true },
      { ...base, documentId: "y", title: "Y", teamCitations: 3, related: true },
      {
        documentId: "x",
        title: "X",
        teamCitations: 3,
        related: true,
        lastCitedAt: "2026-10-05T00:00:00.000Z"
      },
      { ...base, documentId: "w", title: "W", teamCitations: 3, related: true }
    ]);
    expect(picked.map((s) => s.documentId)).toEqual(["x", "w", "y"]);
  });

  it("never suggests hidden titles, uncited or repeated sources", () => {
    expect(
      selectSourceSuggestions([
        { ...base, documentId: "hidden", title: null, teamCitations: 9, related: true },
        { ...base, documentId: "zero", title: "Zero", teamCitations: 0 },
        { ...base, documentId: "dup", title: "Dup", teamCitations: 4 },
        { ...base, documentId: "dup", title: "Dup", teamCitations: 4 }
      ])
    ).toEqual([{ documentId: "dup", title: "Dup", reason: "team_top", teamCitations: 4 }]);
    expect(selectSourceSuggestions([])).toEqual([]);
  });
});
