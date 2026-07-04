import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Source } from "@/types/api";
import {
  annotateCitations,
  CITE_HREF_PREFIX,
  CITE_UNKNOWN_HREF
} from "@/lib/citation-rendering";

interface AnswerMarkdownProps {
  answer: string;
  sources: Source[];
  onChipClick: (chunkId: string) => void;
}

/**
 * Render the LLM answer as GitHub-flavored Markdown with inline citation
 * chips. Anchors never render as real links: #cite: hrefs become chip
 * buttons, #cite-unknown becomes destructive text (visible model drift),
 * and anything else — which rule 6 bans the model from emitting — is
 * downgraded to plain text.
 */
export function AnswerMarkdown({
  answer,
  sources,
  onChipClick
}: AnswerMarkdownProps): JSX.Element {
  const { markdown } = useMemo(() => annotateCitations(answer, sources), [answer, sources]);
  const titleByChunkId = useMemo(
    () => new Map(sources.map((s) => [s.chunk_id, s.doc_title])),
    [sources]
  );

  function renderAnchor({
    href,
    children
  }: {
    href?: string;
    children?: ReactNode;
  }): JSX.Element {
    if (href?.startsWith(CITE_HREF_PREFIX)) {
      const chunkId = href.slice(CITE_HREF_PREFIX.length);
      const title = titleByChunkId.get(chunkId) ?? "Unknown document";
      return (
        <button
          type="button"
          onClick={() => onChipClick(chunkId)}
          className="mx-0.5 inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0 align-baseline text-xs font-medium text-primary hover:bg-primary/20"
          aria-label={`Citation ${childrenToText(children)} — ${title}`}
        >
          [{children}]
        </button>
      );
    }
    if (href === CITE_UNKNOWN_HREF) {
      return (
        <span className="rounded bg-destructive/10 px-1 text-destructive">{children}</span>
      );
    }
    // Real hyperlinks are banned by prompt rule 6; if one slips through,
    // render its text without the anchor so nothing clickable escapes.
    return <span>{children}</span>;
  }

  return (
    <div className="text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: renderAnchor,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0">{children}</ol>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0">{children}</ul>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border bg-secondary/40 px-2 py-1 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-2 py-1 align-top">{children}</td>
          ),
          // Rule 6 bans headings/code; if the model emits them anyway they
          // degrade to ordinary emphasis rather than shouting at the CSR.
          h1: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
          h2: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
          h3: ({ children }) => <p className="my-2 font-semibold">{children}</p>,
          code: ({ children }) => <span>{children}</span>,
          pre: ({ children }) => <div className="my-2">{children}</div>
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  return "";
}
