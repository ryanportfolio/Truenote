import type { Source } from "@/types/api";

export type CitationLinkKind = "passage" | "version" | "current";

/** Describe only the durability the receipt actually contains. */
export function citationLinkKind(source: Source): CitationLinkKind | null {
  if (!source.doc_id) return null;
  if (
    source.document_version_id &&
    source.source_start !== null &&
    source.source_end !== null
  ) {
    return "passage";
  }
  return source.document_version_id ? "version" : "current";
}

/** Build a version-pinned reader link; query/source add the exact saved span. */
export function citationDocumentHref(
  source: Source,
  queryLogId: string | null
): string | null {
  if (!source.doc_id) return null;
  const base = `/kb/${encodeURIComponent(source.doc_id)}`;
  if (!source.document_version_id) return base;
  const params = new URLSearchParams({ version: source.document_version_id });
  if (queryLogId) {
    params.set("query", queryLogId);
    params.set("source", String(source.citation_index));
  }
  return `${base}?${params.toString()}`;
}
