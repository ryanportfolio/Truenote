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
import { citationDocumentHref } from "@/lib/citationLinks";

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
 * CRM-ready clipboard form: known citations become "[N]", unknown bracket
 * tokens stay verbatim, and cited sources get a matching legend with any
 * durable version/deep link. Markdown stays lightweight and readable.
 */
export function answerForClipboard(
  answer: string,
  sources: Source[],
  options: {
    question?: string;
    queryLogId?: string | null;
    origin?: string;
  } = {}
): string {
  const known = new Set(sources.map((s) => s.chunk_id));
  const ordinals = new Map<string, number>();
  let next = 1;
  const rewritten = answer.replace(CITATION_RE, (raw: string, id: string) => {
    if (!known.has(id)) return raw;
    let ordinal = ordinals.get(id);
    if (ordinal === undefined) {
      ordinal = next;
      next += 1;
      ordinals.set(id, ordinal);
    }
    return `[${ordinal}]`;
  });
  const sourceById = new Map(sources.map((source) => [source.chunk_id, source]));
  const legend = Array.from(ordinals.entries())
    .sort((left, right) => left[1] - right[1])
    .flatMap(([chunkId, ordinal]) => {
      const source = sourceById.get(chunkId);
      if (!source) return [];
      const version = source.version_number ? ` (Version ${source.version_number})` : "";
      const href = citationDocumentHref(source, options.queryLogId ?? null);
      const url =
        href && options.origin ? new URL(href, options.origin).toString() : href;
      return [`[${ordinal}] ${source.doc_title}${version}${url ? ` — ${url}` : ""}`];
    });
  const body = options.question
    ? `Question: ${options.question}\n\nAnswer:\n${rewritten}`
    : rewritten;
  return legend.length > 0 ? `${body}\n\nSources:\n${legend.join("\n")}` : body;
}
