import { useEffect, useState } from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, FileLock2, ShieldAlert } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { getComplianceDocument, getComplianceDocuments } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  ComplianceDocumentResponse,
  ComplianceDocumentSummary,
  CurrentUser
} from "@/types/api";

/**
 * Detailed compliance documents (POA&M, full system security plan,
 * assessment results). The API serves them to super users only and records
 * every document read; the role check here only picks the right screen.
 */
interface CompliancePageProps {
  user: CurrentUser;
}

const SENSITIVE_NOTICE =
  "Contains security-sensitive details. Do not share outside the intended reviewer.";

function Forbidden(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Compliance documents are restricted to super users.
      </p>
    </div>
  );
}

function formatDate(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? isoDate
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "UTC"
      });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SensitiveNotice(): JSX.Element {
  return (
    <p
      role="note"
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/20 px-3 py-2 text-sm text-warning-foreground"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {SENSITIVE_NOTICE}
    </p>
  );
}

function ListSkeleton(): JSX.Element {
  return (
    <div role="status" className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      {[0, 1].map((row) => (
        <div key={row} className="flex items-center gap-6 border-t border-border px-5 py-4 first:border-t-0">
          <div className="skeleton h-4 w-56" />
          <div className="skeleton h-4 w-16" />
          <div className="skeleton ml-auto h-4 w-24" />
        </div>
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function CompliancePage({ user }: CompliancePageProps): JSX.Element {
  if (user.role !== "super_user") return <Forbidden />;
  return <ComplianceList />;
}

function ComplianceList(): JSX.Element {
  const [documents, setDocuments] = useState<ComplianceDocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getComplianceDocuments()
      .then((result) => {
        if (!cancelled) setDocuments(result.documents);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Compliance documents could not load");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Super-user documents
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight">
          Compliance documents
        </h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Detailed versions of the compliance documents. Each document you open is recorded in
          the security log. The{" "}
          <a href="/security/compliance/" className="text-primary underline underline-offset-2 hover:text-primary/80">
            public summaries
          </a>{" "}
          are open to everyone.
        </p>
      </header>

      <SensitiveNotice />

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : documents === null ? (
        <ListSkeleton />
      ) : documents.length === 0 ? (
        <EmptyState
          icon={FileLock2}
          title="No compliance documents yet"
          hint="Documents appear here after the owner uploads them to storage with the compliance upload script."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Version</th>
                <th className="hidden px-4 py-2 font-medium sm:table-cell">Date</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">SHA-256</th>
                <th className="hidden px-4 py-2 text-right font-medium md:table-cell">Size</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => (
                <tr
                  key={doc.slug}
                  className="border-t border-border transition-colors duration-100 ease-out hover:bg-muted/40"
                >
                  <td className="px-4 py-3">
                    <Link
                      href={`/compliance/${doc.slug}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {doc.title}
                    </Link>
                    <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                      {formatDate(doc.date)}
                    </span>
                  </td>
                  <td className="px-4 py-3">{doc.version}</td>
                  <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                    {formatDate(doc.date)}
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <code className="font-mono text-[13px] text-muted-foreground" title={doc.sha256}>
                      {doc.sha256.slice(0, 12)}
                    </code>
                  </td>
                  <td className="hidden px-4 py-3 text-right text-muted-foreground md:table-cell">
                    {formatSize(doc.size)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

interface ComplianceDocumentPageProps {
  user: CurrentUser;
  slug: string;
}

type DocumentState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ready"; document: ComplianceDocumentResponse };

export function ComplianceDocumentPage({ user, slug }: ComplianceDocumentPageProps): JSX.Element {
  if (user.role !== "super_user") return <Forbidden />;
  return <ComplianceDocumentView slug={slug} />;
}

function BackLink(): JSX.Element {
  return (
    <Link href="/compliance" className="btn-whisper inline-flex items-center gap-1.5 self-start px-3 py-1.5 text-sm">
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All compliance documents
    </Link>
  );
}

function ComplianceDocumentView({ slug }: { slug: string }): JSX.Element {
  const [state, setState] = useState<DocumentState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    getComplianceDocument(slug)
      .then((document) => {
        if (cancelled) return;
        setState(document ? { status: "ready", document } : { status: "missing" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: reason instanceof Error ? reason.message : "This document could not load"
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (state.status === "missing") {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
        <BackLink />
        <EmptyState
          icon={FileLock2}
          title="Document not found"
          hint="It may have been replaced by a newer upload. Open the list to see the current documents."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <BackLink />
      {state.status === "error" ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.message}
        </p>
      ) : state.status === "loading" ? (
        <div role="status" className="rounded-lg border border-border bg-card p-5 shadow-card">
          <div className="skeleton h-8 w-2/3" />
          <div className="skeleton mt-3 h-4 w-1/2" />
          <div className="skeleton mt-6 h-4 w-full" />
          <div className="skeleton mt-2 h-4 w-4/5" />
          <span className="sr-only">Loading…</span>
        </div>
      ) : (
        <>
          <header>
            <h1 className="font-display text-3xl font-semibold tracking-tight">
              {state.document.title}
            </h1>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Version</dt>
                <dd className="mt-0.5 font-medium">{state.document.version}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Date</dt>
                <dd className="mt-0.5 font-medium">{formatDate(state.document.date)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">SHA-256</dt>
                <dd className="mt-0.5">
                  <code className="font-mono text-[13px]" title={state.document.sha256}>
                    {state.document.sha256.slice(0, 12)}
                  </code>
                </dd>
              </div>
            </dl>
          </header>
          <SensitiveNotice />
          <article className="rounded-lg border border-border bg-card p-5 text-sm leading-relaxed shadow-card">
            <ComplianceMarkdown markdown={state.document.markdown} />
          </article>
        </>
      )}
    </div>
  );
}

/** The knowledge base reader's Markdown recipe, without citation anchors. */
function ComplianceMarkdown({ markdown }: { markdown: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => (
          <h2 className="mb-2 mt-5 font-display text-xl font-semibold tracking-tight first:mt-0">{children}</h2>
        ),
        h2: ({ id, className, children }) => (
          <h3 id={id} className={cn("mb-2 mt-5 font-display text-lg font-semibold tracking-tight first:mt-0", className)}>{children}</h3>
        ),
        h3: ({ children }) => <h4 className="mb-2 mt-4 text-base font-semibold first:mt-0">{children}</h4>,
        h4: ({ children }) => <h5 className="mb-1.5 mt-4 text-sm font-semibold first:mt-0">{children}</h5>,
        h5: ({ children }) => <h6 className="mb-1.5 mt-4 text-sm font-semibold first:mt-0">{children}</h6>,
        h6: ({ children }) => (
          <h6 className="my-2 text-xs font-semibold uppercase tracking-wide first:mt-0">{children}</h6>
        ),
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
        ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1 first:mt-0 last:mb-0">{children}</ol>,
        ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1 first:mt-0 last:mb-0">{children}</ul>,
        table: ({ children }) => (
          <div className="my-3 overflow-x-auto first:mt-0 last:mb-0">
            <table className="w-full border-collapse text-sm tabular-nums">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border-b border-border px-2 py-1.5 text-left font-medium">{children}</th>
        ),
        td: ({ children }) => <td className="border-t border-border px-2 py-1.5 align-top">{children}</td>,
        // Keep the attributes react-markdown generates (footnote ids, aria and
        // data attributes) so footnote references and backlinks pair up; only
        // external links open a new tab.
        a: ({ node: _node, href, className, children, ...generated }) => {
          const external = typeof href === "string" && /^https?:\/\//i.test(href);
          return (
            <a
              {...generated}
              href={href}
              {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              className={cn("text-primary underline underline-offset-2 hover:text-primary/80", className)}
            >
              {children}
            </a>
          );
        },
        img: ({ alt }) => (
          <span className="my-2 block rounded-md border border-dashed border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            [image{alt ? `: ${alt}` : ""}]
          </span>
        ),
        code: ({ children }) => <code className="rounded bg-muted px-1 font-mono text-[13px]">{children}</code>,
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
            {children}
          </pre>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l border-border pl-3 text-muted-foreground">{children}</blockquote>
        ),
        hr: () => <hr className="my-4 border-border" />
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}
