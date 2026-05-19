/**
 * Parse the LLM's inline [chunk_id] citations into a renderable token stream.
 *
 * The LLM is instructed (see api-server lib/generation/answer.ts →
 * buildSystemPrompt) to cite every factual claim with [chunk_id], where
 * chunk_id is a UUID we fed it. We replace each in-text citation with a
 * numbered chip so CSRs see "[1]" / "[2]" rather than ugly UUIDs. Same
 * chunk_id → same ordinal.
 *
 * Unknown citation ids (not in the sources list) are rendered as raw text
 * with a visible warning — this surfaces model drift rather than hiding it.
 */

import type { Source } from "@/types/api";

const CITATION_RE = /\[([^\]]+)\]/g;

export type CitationToken =
  | { kind: "text"; text: string }
  | { kind: "chip"; chunkId: string; ordinal: number; source: Source }
  | { kind: "unknown-chip"; raw: string };

export function tokenizeAnswer(answer: string, sources: Source[]): CitationToken[] {
  const sourcesByChunkId = new Map(sources.map((s) => [s.chunk_id, s]));
  const ordinalByChunkId = new Map<string, number>();
  let next = 1;

  const out: CitationToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // Reset lastIndex on the shared regex by reassigning a fresh one.
  const re = new RegExp(CITATION_RE.source, "g");
  while ((match = re.exec(answer)) !== null) {
    const start = match.index;
    const end = re.lastIndex;
    if (start > lastIndex) {
      out.push({ kind: "text", text: answer.slice(lastIndex, start) });
    }
    const id = match[1] ?? "";
    const src = sourcesByChunkId.get(id);
    if (src) {
      let ordinal = ordinalByChunkId.get(id);
      if (ordinal === undefined) {
        ordinal = next;
        next += 1;
        ordinalByChunkId.set(id, ordinal);
      }
      out.push({ kind: "chip", chunkId: id, ordinal, source: src });
    } else {
      out.push({ kind: "unknown-chip", raw: match[0] ?? "" });
    }
    lastIndex = end;
  }
  if (lastIndex < answer.length) {
    out.push({ kind: "text", text: answer.slice(lastIndex) });
  }
  return out;
}
