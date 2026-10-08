import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  const sourceByChunkId = useMemo(
    () => new Map(sources.map((s) => [s.chunk_id, s])),
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
      const source = sourceByChunkId.get(chunkId);
      const title = source?.doc_title ?? "Unknown document";
      return (
        <CitationChip
          label={children}
          ariaLabel={`Citation ${childrenToText(children)} — ${title}`}
          title={title}
          excerpt={source ? peekExcerpt(source.excerpt) : null}
          onClick={() => onChipClick(chunkId)}
        />
      );
    }
    if (href === CITE_UNKNOWN_HREF) {
      return (
        <span className="rounded-sm bg-destructive/10 px-1 text-destructive">{children}</span>
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
              <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
            </div>
          ),
          // Cohere table language: horizontal rules only, header carried by
          // weight + rule instead of fill or cell grids.
          th: ({ children }) => (
            <th className="border-b border-border px-2 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-border px-2 py-1.5 align-top">{children}</td>
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

interface CitationChipProps {
  label: ReactNode;
  ariaLabel: string;
  title: string;
  excerpt: string | null;
  onClick: () => void;
}

const PEEK_GAP = 6;
const VIEWPORT_MARGIN = 8;

/**
 * Citation chip with a hover/focus peek: the first lines of the excerpt so a
 * CSR can verify without opening the full panel. The peek is portaled to the
 * body with fixed coordinates, so the answer card's overflow clip can't cut
 * it; it sits above the chip and flips below when there is no room. It is a
 * decorative speed aid (aria-hidden); the click-through panel remains the
 * canonical, screen-reader-reachable receipt.
 */
function CitationChip({ label, ariaLabel, title, excerpt, onClick }: CitationChipProps): JSX.Element {
  const chipRef = useRef<HTMLButtonElement>(null);
  const peekRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    function place(): void {
      const chip = chipRef.current?.getBoundingClientRect();
      const peek = peekRef.current?.getBoundingClientRect();
      if (!chip || !peek) return;
      const above = chip.top - PEEK_GAP - peek.height;
      const top = above >= VIEWPORT_MARGIN ? above : chip.bottom + PEEK_GAP;
      const maxLeft = window.innerWidth - VIEWPORT_MARGIN - peek.width;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(chip.left, maxLeft));
      setPosition({ top, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        onClick={onClick}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="mx-0.5 inline-flex cursor-pointer items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0 align-baseline text-xs font-medium text-primary transition-colors duration-100 ease-out hover:bg-primary/20 active:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        aria-label={ariaLabel}
      >
        [{label}]
      </button>
      {open && excerpt !== null
        ? createPortal(
            <span
              ref={peekRef}
              aria-hidden
              data-citation-peek
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position ? "visible" : "hidden"
              }}
              className="pointer-events-none fixed z-50 block w-72 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-card p-3 text-left shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100"
            >
              <span className="block text-xs font-medium text-card-foreground">{title}</span>
              <span className="mt-1 block whitespace-normal font-mono text-xs leading-relaxed text-muted-foreground">
                {excerpt}
              </span>
            </span>,
            document.body
          )
        : null}
    </>
  );
}

/** Peek shows the start of the excerpt; the panel shows all of it. */
function peekExcerpt(excerpt: string): string {
  return excerpt.length > 160 ? `${excerpt.slice(0, 160).trimEnd()}…` : excerpt;
}

function childrenToText(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join("");
  return "";
}
