import {
  Children,
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from "react";
import { Link } from "wouter";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BookOpen, TextQuote } from "lucide-react";
import { fetchMe, getKbDocument, setKbColorLabel } from "@/lib/api";
import {
  applyOpened,
  buildLookup,
  docCategoryPaths,
  relatedSources,
  type KbTree
} from "@/lib/kbLibrary";
import {
  currentKbLibraryCacheKey,
  kbLibraryCacheKey,
  loadKbLibrary,
  patchKbLibraryCache
} from "@/lib/kbLibraryCache";
import { KB_LIBRARY_COLORS } from "@/lib/kbLibraryColors";
import { markdownNodeIsCited } from "@/lib/citationPassage";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { PassageHighlighter } from "@/components/kb/PassageHighlighter";
import { KbDocPersonalError, useKbDocPersonal } from "@/components/kb-library/KbDocPersonalBar";
import { ReaderHeader, type ReaderCrumb } from "@/components/kb-reader/ReaderHeader";
import {
  ReaderHighlightHint,
  ReaderNoteCard,
  ReaderOutline,
  ReaderRelated,
  goToHeading,
  useStickySide,
  type ReaderHeading
} from "@/components/kb-reader/ReaderSide";
import "@/components/kb-reader/readerBody.css";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type {
  KbColorLabel,
  KbDocumentListItem,
  KbDocumentListResponse,
  KbDocumentResponse,
  KbLibraryColor,
  KbTag
} from "@/types/api";

/** Tag names that describe a source's status, not its subject. */
const STATUS_TAG_NAMES = new Set(["updated", "new"]);

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
      const cacheKey = currentKbLibraryCacheKey();
      setState({ status: "loading" });
      try {
        const doc = await getKbDocument(documentId, citationRequest ?? undefined);
        // Opening the current version counts as a view, so the shortcuts
        // shelf on Sources lists it without waiting for the cache to expire.
        if (doc.isCurrentVersion) {
          const at = new Date().toISOString();
          patchKbLibraryCache(cacheKey, (d) => applyOpened(d, doc.documentId, at));
        }
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
    // A super_user switching programs makes this doc out of scope; the
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
    <div className="mx-auto flex w-full max-w-[76rem] flex-col gap-4 px-3 pb-10 pt-4 sm:px-6 md:pt-2">
      {state.status === "loading" ? (
        <div className="flex flex-col gap-2 pt-4" aria-hidden>
          <div className="skeleton h-4 w-1/3" />
          <div className="skeleton h-9 w-2/3" />
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
        <ReaderArticle key={state.doc.documentId} doc={state.doc} documentContentRef={documentContentRef} />
      ) : null}
    </div>
  );
}

/**
 * Library context for the reader: folder path, tags, related sources and the
 * user's label names come from the Sources library, shared with the Sources
 * page through lib/kbLibraryCache, so moving between sources reuses one copy
 * instead of re-running the library query. The cache is keyed by the
 * signed-in user (from /api/me), so it never serves another user's library.
 * The reader works without it; those parts simply stay hidden.
 */
function useLibraryForReader(
  documentId: string
): [KbDocumentListResponse | null, (apply: (data: KbDocumentListResponse) => KbDocumentListResponse) => void] {
  const [library, setLibrary] = useState<KbDocumentListResponse | null>(null);
  /** The cache key of the library shown here; changes only ever patch that one. */
  const cacheKeyRef = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    fetchMe()
      .then((user) => {
        if (!user) return null;
        const key = kbLibraryCacheKey(user.id);
        return loadKbLibrary(key).then((response) => {
          if (!disposed) cacheKeyRef.current = key;
          return response;
        });
      })
      .then((response) => {
        if (!disposed && response && !response.noProgramSelected) setLibrary(response);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [documentId]);
  function update(apply: (data: KbDocumentListResponse) => KbDocumentListResponse): void {
    setLibrary((prev) => (prev ? apply(prev) : prev));
    patchKbLibraryCache(cacheKeyRef.current, apply);
  }
  return [library, update];
}

/** The user's color names with one color renamed (null removes it), in palette order. */
function withLabel(labels: KbColorLabel[], color: KbLibraryColor, name: string | null): KbColorLabel[] {
  const next = labels.filter((label) => label.color !== color);
  if (name) next.push({ color, name });
  return next.sort((a, b) => KB_LIBRARY_COLORS.indexOf(a.color) - KB_LIBRARY_COLORS.indexOf(b.color));
}

/** Folder trail for the breadcrumb: the source's first folder and its parents. */
function folderCrumbs(item: KbDocumentListItem, tree: KbTree): { crumbs: ReaderCrumb[]; others: ReaderCrumb[] } {
  const known = new Set(item.categoryIds);
  const nodes = tree.order.filter((node) => known.has(node.category.id));
  const first = nodes[0];
  if (!first) return { crumbs: [], others: [] };
  const crumbs: ReaderCrumb[] = [];
  for (let node: typeof first | undefined = first; node; ) {
    crumbs.unshift({ id: node.category.id, name: node.category.name });
    const parentId: string | null = node.category.parentId;
    node = parentId ? tree.byId.get(parentId) : undefined;
  }
  return { crumbs, others: nodes.slice(1).map((node) => ({ id: node.category.id, name: node.category.name })) };
}

function ReaderArticle({
  doc,
  documentContentRef
}: {
  doc: KbDocumentResponse;
  documentContentRef: RefObject<HTMLDivElement>;
}): JSX.Element {
  const personal = useKbDocPersonal(doc.documentId, doc);
  const [library, updateLibrary] = useLibraryForReader(doc.documentId);
  const lookup = useMemo(() => (library ? buildLookup(library) : null), [library?.categories, library?.tags]);
  const listItem = library?.items.find((item) => item.documentId === doc.documentId) ?? null;
  const { crumbs, others } = lookup && listItem ? folderCrumbs(listItem, lookup.tree) : { crumbs: [], others: [] };
  // Status tags ("Updated", "New") stay out of the meta line: the date
  // phrase beside it already says when the source changed.
  const tags =
    lookup && listItem
      ? listItem.tagIds
          .map((id) => lookup.tagsById.get(id))
          .filter((t): t is KbTag => t !== undefined && !STATUS_TAG_NAMES.has(t.name.trim().toLowerCase()))
      : [];
  const related =
    lookup && library && listItem
      ? relatedSources(listItem, library.items, lookup.tree).map((item) => ({
          documentId: item.documentId,
          title: item.title,
          path: docCategoryPaths(item, lookup.tree)[0] ?? null
        }))
      : [];
  const labels = library?.labels ?? [];
  const [headings, setHeadings] = useState<ReaderHeading[]>([]);
  const sideRef = useStickySide();

  // "On this page" lists the document's section headings as rendered, so
  // the links always match the ids on the page.
  useLayoutEffect(() => {
    const root = documentContentRef.current;
    if (!root) {
      setHeadings([]);
      return;
    }
    const found = Array.from(root.querySelectorAll<HTMLElement>("h2[id]:not([hidden])")).map((el) => ({
      id: el.id,
      text: el.textContent?.trim() ?? ""
    }));
    setHeadings(found.filter((heading) => heading.text));
  }, [doc.documentVersionId, doc.markdown]);

  // A shared link to a section (#section-steps) lands on it.
  useEffect(() => {
    if (headings.length === 0 || doc.citationTarget) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id && headings.some((heading) => heading.id === id)) goToHeading(id);
  }, [headings]);

  async function renameLabel(color: KbLibraryColor, name: string | null): Promise<string | null> {
    try {
      const saved = await setKbColorLabel(color, name);
      updateLibrary((data) => ({ ...data, labels: withLabel(data.labels ?? [], color, saved?.name ?? null) }));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "The label name didn't save. Try again.";
    }
  }

  return (
    <div data-kb-reader className="flex flex-col">
      <ReaderHeader
        crumbs={crumbs}
        otherPaths={others}
        personal={personal}
        labels={labels}
        labelsReady={library !== null}
        onRenameLabel={renameLabel}
      />
      <KbDocPersonalError personal={personal} />
      <div className="mt-2 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_20.5rem] xl:items-start xl:gap-x-7">
        {/* From 1280px the side column follows the reader down the page
          * (useStickySide sets where it pins). Below that its parts flow
          * around the document: note and outline first, related sources last. */}
        <div
          ref={sideRef}
          data-kb-reader-side
          className="contents xl:sticky xl:top-[var(--kb-reader-side-top,1rem)] xl:col-start-2 xl:row-start-1 xl:flex xl:flex-col xl:gap-5"
        >
          <div className="flex min-w-0 flex-col gap-5">
            <ReaderNoteCard personal={personal} />
            <ReaderOutline
              headings={headings}
              className="rounded-lg border border-border bg-card px-4 py-3 xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0"
            />
            {doc.markdown && doc.isCurrentVersion ? <ReaderHighlightHint /> : null}
          </div>
          <ReaderRelated
            items={related}
            className="order-last rounded-lg border border-border bg-card px-4 py-3 xl:order-none xl:rounded-none xl:border-0 xl:border-t xl:bg-transparent xl:px-1 xl:pb-0 xl:pt-5"
          />
        </div>
        <article
          aria-labelledby="kb-doc-title"
          className="kb-reader-doc relative min-w-0 rounded-lg border border-border bg-card px-4 py-6 shadow-card sm:px-8 sm:py-7 xl:col-start-1 xl:row-start-1"
        >
          <header>
            <h1 id="kb-doc-title" className="font-display text-3xl font-semibold tracking-tight sm:text-[2.125rem] sm:leading-tight">
              {doc.title}
            </h1>
            {tags.length > 0 || doc.updatedAt ? (
              <p data-kb-reader-meta className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm text-muted-foreground">
                {tags.length > 0 ? (
                  <span>
                    <span className="sr-only">Tags: </span>
                    {tags.map((tag) => tag.name).join(", ")}
                  </span>
                ) : null}
                {tags.length > 0 && doc.updatedAt ? (
                  <span aria-hidden className="h-3.5 w-px bg-border" />
                ) : null}
                {doc.updatedAt ? (
                  <span>
                    {doc.isCurrentVersion ? "Updated" : "Uploaded"} <RelativeTime iso={doc.updatedAt} />
                  </span>
                ) : null}
              </p>
            ) : null}
          </header>
          {doc.citationAuthorized ? (
            <div data-kb-reader-cited className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-sm">
              <p className="flex min-w-0 items-start gap-2">
                <TextQuote className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <span>
                  <span className="font-medium">
                    {doc.citationTarget ? "Cited passage" : "Cited version"} · Version {doc.versionNumber}
                  </span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                    {doc.citationTarget
                      ? "The exact source span used by the answer is marked below."
                      : "This is the exact version the answer cited, but this receipt has no direct text location."}
                  </span>
                </span>
              </p>
              {!doc.isCurrentVersion ? (
                <Link href={`/kb/${doc.documentId}`} className="btn-whisper shrink-0 px-2.5 py-1 text-xs">
                  Open current version
                </Link>
              ) : null}
            </div>
          ) : null}
          {doc.markdown ? (
            doc.isCurrentVersion ? (
              <div className="kb-reader-highlights">
                <PassageHighlighter documentId={doc.documentId} documentVersionId={doc.documentVersionId}>
                  <div ref={documentContentRef}>
                    <DocMarkdown
                      markdown={doc.markdown}
                      citationTarget={doc.citationTarget}
                      variant="reader"
                      docTitle={doc.title}
                    />
                  </div>
                </PassageHighlighter>
              </div>
            ) : (
              <div ref={documentContentRef}>
                <DocMarkdown
                  markdown={doc.markdown}
                  citationTarget={doc.citationTarget}
                  variant="reader"
                  docTitle={doc.title}
                />
              </div>
            )
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">This document has no readable content yet.</p>
          )}
        </article>
      </div>
    </div>
  );
}

/**
 * Full-document renderer. Unlike AnswerMarkdown (which bans headings and
 * links per the generation contract), real documents legitimately carry
 * both. Images are placeholder-only: parsed markdown references OCR-local
 * files that aren't served, so the alt text stands in.
 *
 * The "reader" variant is the source page's reading layout: section
 * headings get ids for "On this page", ordered lists read as numbered steps
 * and a leading title that repeats the page title is kept but hidden. It
 * never adds or removes text, so saved highlight offsets stay valid.
 */
export function DocMarkdown({
  markdown,
  citationTarget,
  variant = "default",
  docTitle
}: {
  markdown: string;
  citationTarget: KbDocumentResponse["citationTarget"];
  variant?: "default" | "reader";
  /** Reader variant: the page title, so a leading copy of it is not shown twice. */
  docTitle?: string;
}): JSX.Element {
  if (variant === "reader") {
    return (
      <div className="pt-1 text-base leading-relaxed">
        <ReaderMarkdown markdown={markdown} citationTarget={citationTarget} docTitle={docTitle ?? null} />
      </div>
    );
  }
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

function useCitationAttributes(citationTarget: KbDocumentResponse["citationTarget"]) {
  return (node: PositionedMarkdownNode | undefined) => {
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
}

function MarkdownDocument({
  markdown,
  citationTarget
}: {
  markdown: string;
  citationTarget: KbDocumentResponse["citationTarget"];
}): JSX.Element {
  const citationAttributes = useCitationAttributes(citationTarget);
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

// ---------------------------------------------------------------------------
// Reader variant

interface HastLike {
  type?: string;
  value?: string;
  children?: HastLike[];
}

function hastText(node: HastLike | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "part";
}

/**
 * Gives every h1 and h2 of the document a stable id from its text
 * ("section-steps"), numbered when two headings share a name, so
 * "On this page" can link to them.
 */
function rehypeSectionIds() {
  return (tree: HastLike): void => {
    const used = new Map<string, number>();
    const walk = (node: HastLike & { tagName?: string; properties?: Record<string, unknown> }): void => {
      if (node.type === "element" && (node.tagName === "h1" || node.tagName === "h2")) {
        const base = `section-${slugify(hastText(node))}`;
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        node.properties = { ...(node.properties ?? {}), id: seen === 0 ? base : `${base}-${seen + 1}` };
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
  };
}

/** Whether the list being rendered is an ordered list (numbered steps). */
const OrderedListContext = createContext(false);

/**
 * Split a step's first sentence from the rest, so it can read in semibold on
 * its own line. Only for steps with more text after that sentence; a
 * one-sentence step stays regular weight. Works on the leading text only;
 * the text itself is unchanged.
 */
function splitFirstSentence(children: ReactNode): ReactNode {
  const parts = Children.toArray(children);
  const first = parts[0];
  if (typeof first !== "string") return children;
  const match = /^\s*[\s\S]*?[.!?](?=\s|$)/.exec(first);
  const lead = match ? match[0] : null;
  if (!lead || !lead.trim()) return children;
  const hasMore = first.slice(lead.length).trim() !== "" || parts.length > 1;
  if (!hasMore) return children;
  return (
    <>
      <span className="kb-step-lead">{lead}</span>
      {first.slice(lead.length)}
      {parts.slice(1)}
    </>
  );
}

/**
 * Memoized: the reader re-renders on every shortcut, label or note change,
 * and a re-render here would rebuild the document nodes that saved
 * highlights are drawn on.
 */
const ReaderMarkdown = memo(function ReaderMarkdown({
  markdown,
  citationTarget,
  docTitle
}: {
  markdown: string;
  citationTarget: KbDocumentResponse["citationTarget"];
  docTitle: string | null;
}): JSX.Element {
  const citationAttributes = useCitationAttributes(citationTarget);
  // A single leading "# Title" that repeats the page title is the document's
  // own title: hidden (text kept for highlight offsets), and "##" sections
  // become the page's second-level headings. No scroll margin: the reader
  // header sets the scroll pane's padding to clear the sticky header.
  const h1Count = (markdown.match(/^#\s/gm) ?? []).length;
  const normalizedTitle = docTitle?.trim().toLowerCase() ?? null;
  const leadingTitle = h1Count === 1;
  const sectionClass =
    "mb-3 mt-7 border-t border-border pt-6 font-display text-2xl font-semibold tracking-tight first:mt-0 first:border-t-0 first:pt-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSectionIds]}
      components={{
        h1: ({ children, node, id }) => {
          const cited = citationAttributes(node);
          const text = hastText(node as HastLike);
          const isTitle =
            leadingTitle && normalizedTitle !== null && text.trim().toLowerCase() === normalizedTitle && !cited.className;
          if (isTitle) {
            return (
              <h2 hidden data-kb-doc-title>
                {children}
              </h2>
            );
          }
          return (
            <h2 {...cited} id={id} tabIndex={-1} className={cn(sectionClass, cited.className)}>
              {children}
            </h2>
          );
        },
        h2: ({ children, node, id }) => {
          const cited = citationAttributes(node);
          if (leadingTitle) {
            return (
              <h2 {...cited} id={id} tabIndex={-1} className={cn(sectionClass, cited.className)}>
                {children}
              </h2>
            );
          }
          return (
            <h3 {...cited} className={cn("mb-2 mt-6 font-display text-xl font-semibold tracking-tight first:mt-0", cited.className)}>
              {children}
            </h3>
          );
        },
        h3: ({ children, node }) => {
          const cited = citationAttributes(node);
          const Tag = leadingTitle ? "h3" : "h4";
          return (
            <Tag {...cited} className={cn("mb-2 mt-5 font-display text-lg font-semibold tracking-tight first:mt-0", cited.className)}>
              {children}
            </Tag>
          );
        },
        h4: ({ children, node }) => {
          const cited = citationAttributes(node);
          const Tag = leadingTitle ? "h4" : "h5";
          return <Tag {...cited} className={cn("mb-1.5 mt-4 text-base font-semibold first:mt-0", cited.className)}>{children}</Tag>;
        },
        h5: ({ children, node }) => {
          const cited = citationAttributes(node);
          return <h5 {...cited} className={cn("mb-1.5 mt-4 text-sm font-semibold first:mt-0", cited.className)}>{children}</h5>;
        },
        h6: ({ children, node }) => {
          const cited = citationAttributes(node);
          return <h6 {...cited} className={cn("my-2 text-xs font-semibold uppercase tracking-wide first:mt-0", cited.className)}>{children}</h6>;
        },
        p: ({ children, node }) => {
          const cited = citationAttributes(node);
          return <p {...cited} className={cn("my-3 first:mt-0 last:mb-0", cited.className)}>{children}</p>;
        },
        ol: ({ children, node }) => {
          const cited = citationAttributes(node);
          return (
            <OrderedListContext.Provider value={true}>
              <ol {...cited} data-kb-steps className={cn("kb-steps", cited.className)}>
                {children}
              </ol>
            </OrderedListContext.Provider>
          );
        },
        ul: ({ children, node }) => {
          const cited = citationAttributes(node);
          return (
            <OrderedListContext.Provider value={false}>
              <ul {...cited} className={cn("my-3 ml-5 list-disc space-y-1.5 marker:text-primary first:mt-0 last:mb-0", cited.className)}>
                {children}
              </ul>
            </OrderedListContext.Provider>
          );
        },
        li: ({ children }) => <ReaderListItem>{children}</ReaderListItem>,
        table: ({ children, node }) => {
          const cited = citationAttributes(node);
          return <ReaderTable cited={cited}>{children}</ReaderTable>;
        },
        th: ({ children }) => (
          <th className="border-b border-border px-2 py-2 text-left font-medium sm:px-3">{children}</th>
        ),
        td: ({ children }) => <td className="border-t border-border px-2 py-2 align-top sm:px-3">{children}</td>,
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
        code: ({ children }) => <code className="rounded bg-muted px-1 font-mono text-[13px]">{children}</code>,
        pre: ({ children, node }) => {
          const cited = citationAttributes(node);
          return (
            <pre {...cited} className={cn("my-3 overflow-x-auto rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed", cited.className)}>
              {children}
            </pre>
          );
        },
        blockquote: ({ children, node }) => {
          const cited = citationAttributes(node);
          return (
            <blockquote {...cited} className={cn("my-3 border-l-2 border-border pl-3 text-foreground", cited.className)}>
              {children}
            </blockquote>
          );
        },
        hr: ({ node }) => {
          const cited = citationAttributes(node);
          return <hr {...cited} className={cn("my-5 border-border", cited.className)} />;
        }
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
});

/**
 * A document table that scrolls sideways when it is wider than the page.
 * While part of it is out of view, readerBody.css fades the right edge and
 * shows "Scroll for more" under it. The label is CSS generated content, so
 * the document text that saved highlights are anchored to stays unchanged.
 */
function ReaderTable({
  cited,
  children
}: {
  cited: ReturnType<ReturnType<typeof useCitationAttributes>>;
  children?: ReactNode;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ wide: false, more: false });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function update(): void {
      if (!el) return;
      const hidden = el.scrollWidth - el.clientWidth;
      const next = { wide: hidden > 1, more: hidden - el.scrollLeft > 1 };
      setOverflow((prev) => (prev.wide === next.wide && prev.more === next.more ? prev : next));
    }
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, []);

  return (
    <div
      {...cited}
      data-kb-table-wrap
      data-wide={overflow.wide ? "" : undefined}
      data-more={overflow.more ? "" : undefined}
      className={cn("kb-table-wrap my-4 first:mt-0 last:mb-0", cited.className)}
    >
      <div ref={scrollRef} data-kb-table-scroll className="overflow-x-auto">
        <table className="w-full border-collapse text-[15px] tabular-nums">{children}</table>
      </div>
    </div>
  );
}

function ReaderListItem({ children }: { children?: ReactNode }): JSX.Element {
  const ordered = useContext(OrderedListContext);
  return <li>{ordered ? splitFirstSentence(children) : children}</li>;
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
