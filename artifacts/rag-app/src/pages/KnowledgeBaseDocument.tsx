import { useEffect, useState } from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, BookOpen } from "lucide-react";
import { getKbDocument } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type { KbDocumentResponse } from "@/types/api";

type DocState =
  | { status: "loading" }
  | { status: "error"; message: string; notFound: boolean }
  | { status: "ready"; doc: KbDocumentResponse };

export function KbDocumentPage({ documentId }: { documentId: string }): JSX.Element {
  const [state, setState] = useState<DocState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      setState({ status: "loading" });
      try {
        const doc = await getKbDocument(documentId);
        if (!cancelled) setState({ status: "ready", doc });
      } catch (err) {
        if (!cancelled) {
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
      cancelled = true;
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, load as EventListener);
    };
  }, [documentId]);

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
                Updated <RelativeTime iso={state.doc.updatedAt} />
              </p>
            ) : null}
          </header>
          {state.doc.markdown ? (
            <DocMarkdown markdown={state.doc.markdown} />
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
function DocMarkdown({ markdown }: { markdown: string }): JSX.Element {
  return (
    <div className="pt-4 text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h2 className="mb-2 mt-5 font-display text-xl font-semibold tracking-tight first:mt-0">
              {children}
            </h2>
          ),
          h2: ({ children }) => (
            <h3 className="mb-2 mt-5 font-display text-lg font-semibold tracking-tight first:mt-0">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h4 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h4>
          ),
          h4: ({ children }) => (
            <h5 className="mb-1.5 mt-4 text-sm font-semibold first:mt-0">{children}</h5>
          ),
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ol: ({ children }) => (
            <ol className="my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0">{children}</ol>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0">{children}</ul>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto first:mt-0 last:mb-0">
              <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
            </div>
          ),
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
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l border-border pl-3 text-muted-foreground">
              {children}
            </blockquote>
          )
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
