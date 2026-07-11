import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, BookOpen, TextQuote } from "lucide-react";
import { getKbDocument } from "@/lib/api";
import { markdownNodeIsCited } from "@/lib/citationPassage";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { PassageHighlighter } from "@/components/kb/PassageHighlighter";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type { KbDocumentResponse } from "@/types/api";

type DocState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound: boolean }
  | { status: "ready"; doc: KbDocumentResponse };

export function KbDocumentPage({ documentId }: { documentId: string }): JSX.Element {
  const [state, setState] = useState<DocState>({ status: "loading" });
  const loadGenerationRef = useRef(0);
  const documentContentRef = useRef<HTMLDivElement>(null);
  const citationRequest = readCitationRequest();
  const citationRequestKey = citationRequest
    ? `${citationRequest.versionId}:${citationRequest.queryLogId ?? ""}:${citationRequest.sourceIndex ?? ""}`
    : "current";

  useEffect(() => {
    let disposed = false;
    async function load(): Promise<void> {
      const generation = ++loadGenerationRef.current;
      setState({ status: "loading" });
      try {
        const doc = await getKbDocument(documentId, citationRequest ?? undefined);
        if (!disposed && generation === loadGenerationRef.current) {
          setState({ status: "ready", doc });
        }
      } catch (err) {
        if (!disposed && generation === loadGenerationRef.current) {
          const message = err instanceof Error ? err.message : "Failed to load document";
          setState({
            status: "error",
            message,
            notFound: message.startsWith("HTTP 404")
          });
        }
      }
    }
    void load();
    // A super_user switching programs makes this doc out of scope — the
    // reload surfaces the clean not-found state instead of stale content.
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load as EventListener);
    return () => {
      disposed = true;
      loadGenerationRef.current += 1;
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load as EventListener);
    };
  }, [citationRequestKey, documentId]);

  useEffect(() => {
    if (state.status !== "ready" || !state.doc.citationTarget) return;
    const frame = requestAnimationFrame(() => {
      const citedPassage = documentContentRef.current?.querySelector<HTMLElement>(
        "[data-citation-target]"
      );
      citedPassage?.focus({ preventScroll: true });
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      citedPassage?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "center"
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [state]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-6">
      <div>
        <Link href="/kb" className="btn-whisper inline-flex gap-1.5 px-3 py-1.5 text-sm">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Knowledge base
        </Link>
      </div>

      {state.status === "loading" ? (
        <div className="flex flex-col gap-2" aria-hidden>
          <div className="skeleton h-8 w-2/3" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-full" />
          <div className="skeleton h-4 w-4/5" />
        </div>
      ) : null}

      {state.status === "error" ? (
        state.notFound ? (
          <EmptyState
            icon={BookOpen}
            title="Document not available"
            hint="It may have been removed, or it belongs to a different program."
          />
        ) : (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {state.message}
          </p>
        )
      ) : null}

      {state.status === "ready" ? (
        <article className="rounded-lg border border-border bg-card p-6 shadow-card">
          <header className="border-b border-border pb-4">
            <h1 className="font-display text-2xl font-semibold tracking-tight">
              {state.doc.title}
            </h1>
            {state.doc.updatedAt ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {state.doc.isCurrentVersion ? "Updated" : "Uploaded"}{" "}
                <RelativeTime iso={state.doc.updatedAt} />
              </p>
            ) : null}
          </header>
          {state.doc.citationAuthorized ? (
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
              <p className="flex min-w-0 items-start gap-2">
                <TextQuote className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span>
                  <span className="font-medium">
                    {state.doc.citationTarget ? "Cited passage" : "Cited version"} · Version {state.doc.versionNumber}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {state.doc.citationTarget
                      ? "The exact source span used by the answer is marked below."
                      : "The cited version is pinned, but this receipt has no direct text location."}
                  </span>
                </span>
              </p>
              {!state.doc.isCurrentVersion ? (
                <Link href={`/kb/${state.doc.documentId}`} className="btn-whisper shrink-0 px-2.5 py-1 text-xs">
                  Open current version
                </Link>
              ) : null}
            </div>
          ) : null}
          {state.doc.markdown ? (
            state.doc.isCurrentVersion ? (
              <PassageHighlighter
                documentId={state.doc.documentId}
                documentVersionId={state.doc.documentVersionId}
              >
                <div ref={documentContentRef}>
                  <DocMarkdown
                    markdown={state.doc.markdown}
                    citationTarget={state.doc.citationTarget}
                  />
                </div>
              </PassageHighlighter>
            ) : (
              <div ref={documentContentRef}>
                <DocMarkdown
                  markdown={state.doc.markdown}
                  citationTarget={state.doc.citationTarget}
                />
              </div>
            )
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              This document has no readable content yet.
            </p>
          )}
        </article>
      ) : null}
    </div>
  );
}
/**
 * Full-document renderer. Unlike AnswerMarkdown (which bans headings and
 * links per the generation contract), real documents legitimately carry
 * both. Images are placeholder-only: parsed markdown references OCR-local
 * files that aren't served, so the alt text stands in.
 */
export function DocMarkdown({
  markdown,
  citationTarget
}: {
  markdown: string;
  citationTarget: KbDocumentResponse["citationTarget"];
}): JSX.Element {
  return (
    <div className="pt-4 text-sm leading-relaxed">
      <MarkdownDocument markdown={markdown} citationTarget={citationTarget} />
    </div>
  );
}

interface PositionedMarkdownNode {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function MarkdownDocument({
  markdown,
  citationTarget
}: {
  markdown: string;
  citationTarget: KbDocumentResponse["citationTarget"];
}): JSX.Element {
  const citationAttributes = (node: PositionedMarkdownNode | undefined) => {
    const cited = markdownNodeIsCited(
      node?.position?.start?.offset,
      node?.position?.end?.offset,
      citationTarget
    );
    return cited
      ? {
          "data-citation-target": "true" as const,
          tabIndex: -1,
          className:
            "scroll-mt-24 rounded-sm bg-primary/10 ring-1 ring-inset ring-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        }
      : { className: undefined };
  };
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
          h1: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h2 {...cited} className={cn("mb-2 mt-5 font-display text-xl font-semibold tracking-tight first:mt-0", cited.className)}>
              {children}
            </h2>;
          },
          h2: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h3 {...cited} className={cn("mb-2 mt-5 font-display text-lg font-semibold tracking-tight first:mt-0", cited.className)}>
              {children}
            </h3>;
          },
          h3: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h4 {...cited} className={cn("mb-2 mt-4 text-base font-semibold first:mt-0", cited.className)}>{children}</h4>;
          },
          h4: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h5 {...cited} className={cn("mb-1.5 mt-4 text-sm font-semibold first:mt-0", cited.className)}>{children}</h5>;
          },
          h5: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h6 {...cited} className={cn("mb-1.5 mt-4 text-sm font-semibold first:mt-0", cited.className)}>{children}</h6>;
          },
          h6: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <h6 {...cited} className={cn("my-2 text-xs font-semibold uppercase tracking-wide first:mt-0", cited.className)}>{children}</h6>;
          },
          p: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <p {...cited} className={cn("my-2 first:mt-0 last:mb-0", cited.className)}>{children}</p>;
          },
          ol: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <ol {...cited} className={cn("my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0", cited.className)}>{children}</ol>;
          },
          ul: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <ul {...cited} className={cn("my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0", cited.className)}>{children}</ul>;
          },
          table: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <div {...cited} className={cn("my-3 overflow-x-auto first:mt-0 last:mb-0", cited.className)}>
              <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
            </div>;
          },
          th: ({ children }) => (
            <th className="border-b border-border px-2 py-1.5 text-left font-medium">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-t border-border px-2 py-1.5 align-top">{children}</td>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="my-2 block rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              [image{alt ? `: ${alt}` : ""}]
            </span>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 font-mono text-[13px]">{children}</code>
          ),
          pre: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <pre {...cited} className={cn("my-2 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed", cited.className)}>
              {children}
            </pre>;
          },
          blockquote: ({ children, node }) => {
            const cited = citationAttributes(node);
            return <blockquote {...cited} className={cn("my-2 border-l border-border pl-3 text-muted-foreground", cited.className)}>
              {children}
            </blockquote>;
          },
          hr: ({ node }) => {
            const cited = citationAttributes(node);
            return <hr {...cited} className={cn("my-4 border-border", cited.className)} />;
          }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function readCitationRequest(): {
  versionId: string;
  queryLogId?: string;
  sourceIndex?: number;
} | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const versionId = params.get("version");
  if (!versionId) return null;
  const queryLogId = params.get("query");
  const rawSource = params.get("source");
  const sourceIndex = rawSource !== null && /^(0|[1-9]\d*)$/.test(rawSource)
    ? Number(rawSource)
    : undefined;
  return {
    versionId,
    ...(queryLogId ? { queryLogId } : {}),
    ...(sourceIndex !== undefined ? { sourceIndex } : {})
  };
}
