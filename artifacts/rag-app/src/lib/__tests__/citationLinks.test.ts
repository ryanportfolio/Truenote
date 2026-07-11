import { describe, expect, it } from "vitest";
import { citationDocumentHref, citationLinkKind } from "../citationLinks";
import type { Source } from "@/types/api";

const source: Source = {
  chunk_id: "chunk",
  doc_title: "Policy",
  excerpt: "Exact passage",
  doc_id: "document-id",
  document_version_id: "version-id",
  version_number: 3,
  citation_index: 2,
  source_start: 10,
  source_end: 23
};

describe("citationDocumentHref", () => {
  it("pins the version and immutable query source position", () => {
    expect(citationDocumentHref(source, "query-id")).toBe(
      "/kb/document-id?version=version-id&query=query-id&source=2"
    );
  });

  it("keeps a document link when legacy sources have no version", () => {
    expect(
      citationDocumentHref(
        { ...source, document_version_id: null, version_number: null },
        "query-id"
      )
    ).toBe("/kb/document-id");
  });

  it("distinguishes exact, version-only, and unpinned links", () => {
    expect(citationLinkKind(source)).toBe("passage");
    expect(
      citationLinkKind({ ...source, source_start: null, source_end: null })
    ).toBe("version");
    expect(
      citationLinkKind({
        ...source,
        document_version_id: null,
        version_number: null,
        source_start: null,
        source_end: null
      })
    ).toBe("current");
    expect(citationLinkKind({ ...source, doc_id: null })).toBeNull();
  });
});
