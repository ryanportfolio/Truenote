import { describe, expect, it } from "vitest";
import {
  applyVersionActivity,
  citationTargetFromLinkedSource,
  citationReceiptFromLinkedSource,
  citationTargetMatchesMarkdown,
  isMissingCitationSnapshotsColumn,
  linkedSourceFromChunk,
  parseCitationSnapshots,
  withoutDurableCitation
} from "../citations.js";

const ids = {
  chunk: "1526858c-e128-43ad-84bb-22b05d34e801",
  document: "8cc5fe95-1b45-4c5c-a700-caa8b6c55b78",
  version: "9e382f88-d8e8-4599-92d3-1c0b5873d631"
};

function linkedSource() {
  return linkedSourceFromChunk({
    chunkId: ids.chunk,
    docTitle: "Cancellation Policy",
    content:
      "[Cancellation Policy > Standard Fees]\nThe cancellation fee is **$25**.",
    documentId: ids.document,
    documentVersionId: ids.version,
    versionNumber: 3,
    metadata: {
      context_header: "[Cancellation Policy > Standard Fees]",
      source_start: 120,
      source_end: 159
    },
    citationIndex: 0
  });
}

describe("citation snapshots", () => {
  it("strips synthetic context and keeps raw markdown anchors", () => {
    expect(linkedSource()).toEqual({
      chunk_id: ids.chunk,
      doc_title: "Cancellation Policy",
      excerpt: "The cancellation fee is **$25**.",
      doc_id: ids.document,
      document_version_id: ids.version,
      version_number: 3,
      citation_index: 0,
      source_start: 120,
      source_end: 159
    });
  });

  it("never anchors image-description chunks into parsed markdown", () => {
    const source = linkedSourceFromChunk({
      chunkId: ids.chunk,
      docTitle: "Cancellation Policy",
      content: "[Cancellation Policy]\n[Image on page 2]: Fee table.",
      documentId: ids.document,
      documentVersionId: ids.version,
      versionNumber: 3,
      metadata: {
        has_image: true,
        context_header: "[Cancellation Policy]",
        source_start: 1,
        source_end: 20
      },
      citationIndex: 0
    });

    expect(source.excerpt).toBe("[Image on page 2]: Fee table.");
    expect(source.source_start).toBeNull();
    expect(source.source_end).toBeNull();
    expect(
      citationReceiptFromLinkedSource(source, {
        sourceIndex: 0,
        documentId: ids.document,
        documentVersionId: ids.version
      })
    ).toEqual({ target: null });
  });

  it("rejects reordered snapshot positions", () => {
    expect(parseCitationSnapshots([{ ...linkedSource(), citation_index: 1 }])).toBeNull();
  });

  it("requires source position, document, and version to resolve a target", () => {
    const source = linkedSource();
    expect(
      citationTargetFromLinkedSource(source, {
        sourceIndex: 0,
        documentId: ids.document,
        documentVersionId: ids.version
      })
    ).toEqual({
      excerpt: "The cancellation fee is **$25**.",
      sourceStart: 120,
      sourceEnd: 159
    });
    expect(
      citationTargetFromLinkedSource(source, {
        sourceIndex: 0,
        documentId: ids.document,
        documentVersionId: "0270dfbc-563c-4d61-9f5d-ff5dd50ce0cb"
      })
    ).toBeNull();
  });

  it("recognizes a driver-wrapped missing-column error", () => {
    expect(
      isMissingCitationSnapshotsColumn({ cause: { code: "42703" } })
    ).toBe(true);
    expect(isMissingCitationSnapshotsColumn({ code: "42P01" })).toBe(false);
  });

  it("rejects stale offsets whose source text changed", () => {
    const target = {
      excerpt: "The cancellation fee is **$25**.",
      sourceStart: 4,
      sourceEnd: 36
    };
    expect(
      citationTargetMatchesMarkdown("xxxxThe cancellation fee is **$25**.", target)
    ).toBe(true);
    expect(
      citationTargetMatchesMarkdown("xxxxThe cancellation fee is **$50**.", target)
    ).toBe(false);
    const codeMarkdown = "```python\nif covered:\n    refund()\n```";
    const codeTarget = {
      excerpt: codeMarkdown,
      sourceStart: 0,
      sourceEnd: codeMarkdown.length
    };
    expect(citationTargetMatchesMarkdown(codeMarkdown, codeTarget)).toBe(true);
    expect(
      citationTargetMatchesMarkdown(
        "```python\nif covered:\n\t\t  refund()\n```",
        codeTarget
      )
    ).toBe(false);
  });

  it("does not advertise a pinned version when snapshot persistence failed", () => {
    expect(withoutDurableCitation(linkedSource())).toMatchObject({
      doc_id: ids.document,
      document_version_id: null,
      version_number: null,
      source_start: null,
      source_end: null
    });
  });
});

describe("applyVersionActivity", () => {
  const activeVersion = "9e382f88-d8e8-4599-92d3-1c0b5873d631";
  const supersededVersion = "0270dfbc-563c-4d61-9f5d-ff5dd50ce0cb";
  const deletedVersion = "b1c2d3e4-5f60-4a71-8b92-0c1d2e3f4a5b";

  function sourceForVersion(versionId: string, citationIndex: number) {
    return linkedSourceFromChunk({
      chunkId: ids.chunk,
      docTitle: "Cancellation Policy",
      content: "[Cancellation Policy]\nThe cancellation fee is **$25**.",
      documentId: ids.document,
      documentVersionId: versionId,
      versionNumber: 3,
      metadata: {
        context_header: "[Cancellation Policy]",
        source_start: 22,
        source_end: 54
      },
      citationIndex
    });
  }

  it("keeps active-version citations unchanged", () => {
    const out = applyVersionActivity(
      [sourceForVersion(activeVersion, 0)],
      new Map([[activeVersion, true]])
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.superseded).toBeUndefined();
  });

  it("flags a superseded (inactive but existing) version, preserving the receipt", () => {
    const out = applyVersionActivity(
      [sourceForVersion(supersededVersion, 0)],
      new Map([[supersededVersion, false]])
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.superseded).toBe(true);
    expect(out[0]?.excerpt).toBe("The cancellation fee is **$25**.");
  });

  it("drops a citation whose version no longer exists (document deleted)", () => {
    const out = applyVersionActivity(
      [sourceForVersion(deletedVersion, 0)],
      new Map([[activeVersion, true]])
    );
    expect(out).toHaveLength(0);
  });

  it("passes through legacy sources that have no version id", () => {
    const legacy = withoutDurableCitation(sourceForVersion(activeVersion, 0));
    expect(legacy.document_version_id).toBeNull();
    expect(applyVersionActivity([legacy], new Map())).toEqual([legacy]);
  });

  it("fails open (keeps everything) when the activity lookup failed", () => {
    const sources = [
      sourceForVersion(activeVersion, 0),
      sourceForVersion(deletedVersion, 1)
    ];
    expect(applyVersionActivity(sources, null)).toEqual(sources);
  });

  it("resolves a mixed set per source, keeping original citation indexes", () => {
    const out = applyVersionActivity(
      [
        sourceForVersion(activeVersion, 0),
        sourceForVersion(supersededVersion, 1),
        sourceForVersion(deletedVersion, 2)
      ],
      new Map([
        [activeVersion, true],
        [supersededVersion, false]
      ])
    );
    expect(out.map((s) => s.citation_index)).toEqual([0, 1]);
    expect(out[0]?.superseded).toBeUndefined();
    expect(out[1]?.superseded).toBe(true);
  });
});
