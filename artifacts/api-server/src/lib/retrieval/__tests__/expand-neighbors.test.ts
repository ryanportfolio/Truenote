import { describe, expect, it } from "vitest";
import { expandWithNeighbors, type RetrievalChunk } from "../query.js";

function ranked(id: string, versionId: string, score: number): RetrievalChunk {
  return {
    id,
    content: `content ${id}`,
    documentVersionId: versionId,
    documentId: "doc-1",
    versionNumber: 1,
    programId: "prog-1",
    docTitle: "Doc",
    metadata: {},
    relevanceScore: score
  };
}

function row(id: string, versionId: string, ordinal: number) {
  return {
    id,
    content: `content ${id}`,
    document_version_id: versionId,
    version_number: 1,
    program_id: "prog-1",
    doc_title: "Doc",
    document_id: "doc-1",
    ordinal,
    metadata: {}
  };
}

describe("expandWithNeighbors", () => {
  it("inserts neighbors after their anchor, ordinal-sorted, flagged and unscored", () => {
    const out = expandWithNeighbors(
      [ranked("a", "v1", 0.9)],
      1,
      [row("n2", "v1", 6), row("n1", "v1", 4)]
    );
    expect(out.map((c) => c.id)).toEqual(["a", "n1", "n2"]);
    expect(out[1]?.neighbor).toBe(true);
    expect(out[1]?.relevanceScore).toBe(0);
    expect(out[0]?.neighbor).toBeUndefined();
  });

  it("drops neighbors that are already ranked hits", () => {
    const out = expandWithNeighbors(
      [ranked("a", "v1", 0.9), ranked("b", "v1", 0.8)],
      2,
      [row("b", "v1", 3), row("n1", "v1", 1)]
    );
    expect(out.map((c) => c.id)).toEqual(["a", "n1", "b"]);
  });

  it("does not attach neighbors to anchors beyond anchorCount", () => {
    const out = expandWithNeighbors(
      [ranked("a", "v1", 0.9), ranked("b", "v2", 0.8)],
      1,
      [row("n1", "v2", 1)]
    );
    // n1 belongs to b's version but b is past the anchor cutoff.
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps rerank order for the ranked chunks", () => {
    const out = expandWithNeighbors(
      [ranked("a", "v1", 0.9), ranked("b", "v2", 0.8)],
      2,
      []
    );
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
