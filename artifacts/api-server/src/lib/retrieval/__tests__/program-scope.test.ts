import { describe, expect, it } from "vitest";
import { filterToProgramScope, type RetrievalChunk } from "../query.js";

function chunk(id: string, programId: string): RetrievalChunk {
  return {
    id,
    content: `content ${id}`,
    documentVersionId: `version-${id}`,
    documentId: `document-${id}`,
    versionNumber: 1,
    programId,
    docTitle: "Doc",
    metadata: {},
    relevanceScore: 0.9
  };
}

describe("filterToProgramScope", () => {
  it("keeps only chunks belonging to the requested program", () => {
    const result = filterToProgramScope(
      [chunk("a", "program-1"), chunk("b", "program-2"), chunk("c", "program-1")],
      "program-1"
    );
    expect(result.kept.map((c) => c.id)).toEqual(["a", "c"]);
    expect(result.dropped.map((c) => c.id)).toEqual(["b"]);
  });

  it("drops nothing when every chunk is in scope (the correct-operation case)", () => {
    const chunks = [chunk("a", "program-1"), chunk("b", "program-1")];
    const result = filterToProgramScope(chunks, "program-1");
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it("fails closed when EVERY chunk is cross-program", () => {
    // Simulates a hypothetical future SQL edit that widened program scope: the
    // boundary drops the whole leaked set rather than serving another tenant.
    const result = filterToProgramScope(
      [chunk("a", "program-2"), chunk("b", "program-3")],
      "program-1"
    );
    expect(result.kept).toHaveLength(0);
    expect(result.dropped.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("handles an empty chunk set", () => {
    const result = filterToProgramScope([], "program-1");
    expect(result.kept).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
  });
});
