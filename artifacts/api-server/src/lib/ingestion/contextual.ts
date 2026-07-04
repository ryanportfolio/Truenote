/**
 * Contextual chunk headers — the no-LLM core of Anthropic's "contextual
 * retrieval". A chunk that says "The fee is $25" embeds and BM25-indexes
 * poorly because its context (which document? which section?) lives in the
 * doc title and headings, not the chunk body. Prepending a one-line header
 * puts that context into BOTH the embedding input and content_tsv (a DB
 * generated column over `content`), so semantic and exact-match retrieval
 * see it.
 *
 * The header is part of the stored chunk content on purpose: a separate
 * column would need DDL plus a content_tsv rebuild, and the bracket line
 * doubles as useful provenance in the citation side panel.
 * metadata.context_header records what was prepended so a future UI can
 * strip or style it.
 */

export function buildContextHeader(docTitle: string, headingPath: string[] = []): string {
  const parts: string[] = [];
  const push = (raw: string): void => {
    const t = raw.trim();
    if (!t) return; // chunker pads skipped heading levels with ""
    const prev = parts[parts.length - 1];
    // Drop immediate repeats — a doc's H1 usually restates the title.
    if (prev && prev.toLowerCase() === t.toLowerCase()) return;
    parts.push(t);
  };
  push(docTitle);
  for (const h of headingPath) push(h);
  if (parts.length === 0) return "";
  return `[${parts.join(" > ")}]`;
}

/** Idempotent: re-ingesting already-contextualized content won't stack headers. */
export function prependContextHeader(header: string, content: string): string {
  if (!header) return content;
  if (content === header || content.startsWith(`${header}\n`)) return content;
  return `${header}\n${content}`;
}

/**
 * Remove a previously-prepended header (recorded in metadata.context_header)
 * so re-headering after a doc rename doesn't stack two bracket lines.
 */
export function stripContextHeader(content: string, header?: string): string {
  if (!header) return content;
  if (content === header) return "";
  if (content.startsWith(`${header}\n`)) return content.slice(header.length + 1);
  return content;
}
