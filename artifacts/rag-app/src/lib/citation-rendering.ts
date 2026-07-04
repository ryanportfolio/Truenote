/**
 * Rewrite the LLM's inline [chunk_id] citations into markdown link syntax
 * the AnswerMarkdown component turns into numbered chips.
 *
 * The LLM is instructed (see api-server lib/generation/answer.ts →
 * buildSystemPrompt) to cite every factual claim with [chunk_id], where
 * chunk_id is a UUID we fed it, and to format the rest of the answer as
 * GitHub-flavored Markdown (rule 6 bans real links, so bracket tokens are
 * citations by contract).
 *
 * Known ids become `[N](#cite:<chunk_id>)` — rendered as a "[N]" chip.
 * Unknown ids become `[<raw>](#cite-unknown)` — rendered as destructive
 * text, surfacing model drift rather than hiding it.
 */

import type { Source } from "@/types/api";

const CITATION_RE = /\[([^\]]+)\]/g;

export const CITE_HREF_PREFIX = "#cite:";
export const CITE_UNKNOWN_HREF = "#cite-unknown";

export interface AnnotatedAnswer {
  /** Markdown with citations rewritten to #cite: links. */
  markdown: string;
  /** chunk_id → ordinal, in order of first appearance. Same id → same ordinal. */
  ordinals: Map<string, number>;
}

/** Escape characters that would break out of a markdown link label. */
function escapeLabel(text: string): string {
  return text.replace(/([\\[\]])/g, "\\$1");
}

export function annotateCitations(answer: string, sources: Source[]): AnnotatedAnswer {
  const known = new Set(sources.map((s) => s.chunk_id));
  const ordinals = new Map<string, number>();
  let next = 1;

  const markdown = answer.replace(CITATION_RE, (raw: string, id: string) => {
    // If the LLM emitted a real markdown link ("[text](url)", banned by rule
    // 6), the label still gets rewritten here and the "(url)" tail is left
    // as visible text — combined with the renderer refusing to output
    // anchors, a banned link can never render as something clickable.
    if (!known.has(id)) {
      return `[${escapeLabel(raw)}](${CITE_UNKNOWN_HREF})`;
    }
    let ordinal = ordinals.get(id);
    if (ordinal === undefined) {
      ordinal = next;
      next += 1;
      ordinals.set(id, ordinal);
    }
    return `[${ordinal}](${CITE_HREF_PREFIX}${id})`;
  });

  return { markdown, ordinals };
}

/**
 * Plain-text form for the clipboard: known citations become "[N]", unknown
 * bracket tokens are kept verbatim. Markdown syntax is left as-is — CSRs
 * paste into CRM notes where lightweight markdown reads fine.
 */
export function answerForClipboard(answer: string, sources: Source[]): string {
  const known = new Set(sources.map((s) => s.chunk_id));
  const ordinals = new Map<string, number>();
  let next = 1;
  return answer.replace(CITATION_RE, (raw: string, id: string) => {
    if (!known.has(id)) return raw;
    let ordinal = ordinals.get(id);
    if (ordinal === undefined) {
      ordinal = next;
      next += 1;
      ordinals.set(id, ordinal);
    }
    return `[${ordinal}]`;
  });
}
