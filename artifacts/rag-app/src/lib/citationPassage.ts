import type { KbDocumentResponse } from "@/types/api";

/** True when a Markdown AST node overlaps the server-authorized source span. */
export function markdownNodeIsCited(
  nodeStart: number | undefined,
  nodeEnd: number | undefined,
  target: KbDocumentResponse["citationTarget"]
): boolean {
  if (!target || nodeStart === undefined || nodeEnd === undefined) return false;
  return nodeStart < target.sourceEnd && nodeEnd > target.sourceStart;
}
