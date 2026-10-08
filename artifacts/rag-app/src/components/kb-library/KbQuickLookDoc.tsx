import { useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import { ArrowUpRight, X } from "lucide-react";
import { getKbDocument } from "@/lib/api";
import { docCategoryPaths } from "@/lib/kbLibrary";
import { RelativeTime } from "@/components/RelativeTime";
import { DocMarkdown } from "@/pages/KnowledgeBaseDocument";
import type { KbDocumentListItem, KbDocumentResponse, KbTag } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbDocNoteCard, KbDocPersonalActions, type KbDocPersonal } from "./KbDocPersonalBar";
import { TagChip } from "./KbShared";

type BodyState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; doc: KbDocumentResponse };

/**
 * Pin, color and note for the quick look, wired to the library state so the
 * row beside it changes with them (same controls as the reader).
 */
function useLibraryPersonal(doc: KbDocumentListItem): KbDocPersonal {
  const { actions } = useKbLibraryContext();
  const [editing, setEditing] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  function stopEditing(): void {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }
  return {
    item: { pinnedAt: doc.pinnedAt, note: doc.note, noteUpdatedAt: doc.noteUpdatedAt, myColor: doc.myColor },
    error: null,
    editing,
    startEditing: () => setEditing(true),
    stopEditing,
    editButtonRef,
    togglePin: async () => actions.togglePin(doc.documentId),
    setColor: async (color) => actions.setSourceColor(doc.documentId, color),
    saveNote: async (note) => {
      const result = await actions.saveNote(doc.documentId, note);
      if (result.ok) stopEditing();
      return result;
    }
  };
}

/**
 * The quick-look pane with a source in it: the reader's header (breadcrumb,
 * title, Pin and Color, tags, My note) and an "Open source" action, then the
 * source text. Escape or Close hands focus back to the row's Quick look button.
 */
export default function KbQuickLookDoc({
  doc,
  paneId,
  onClose
}: {
  doc: KbDocumentListItem;
  paneId: string;
  onClose: () => void;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const personal = useLibraryPersonal(doc);
  const [body, setBody] = useState<BodyState>({ status: "loading" });
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const paths = docCategoryPaths(doc, lookup.tree);
  const tags = doc.tagIds.map((id) => lookup.tagsById.get(id)).filter((t): t is KbTag => Boolean(t));

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let disposed = false;
    getKbDocument(doc.documentId)
      .then((loaded) => {
        if (!disposed) setBody({ status: "ready", doc: loaded });
      })
      .catch((err: unknown) => {
        if (!disposed) {
          setBody({ status: "error", message: err instanceof Error ? err.message : "This source didn't load." });
        }
      });
    return () => {
      disposed = true;
    };
  }, [doc.documentId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const updatedAt = body.status === "ready" ? body.doc.updatedAt : doc.updatedAt;

  return (
    <aside
      id={paneId}
      aria-labelledby={titleId}
      data-kb-quicklook={doc.documentId}
      className="sticky top-4 flex max-h-[calc(100dvh-7rem)] min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card shadow-card"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Quick look</p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close quick look"
          title="Close (Esc)"
          className="btn-icon -mr-2 h-8 w-8"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3">
        <nav aria-label="Breadcrumb" data-kb-breadcrumb className="mb-1 text-xs text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-x-1.5">
            {paths.length > 0 ? (
              paths[0]!.split(" / ").map((part, i) => (
                <li key={`${part}-${i}`} className="flex items-center gap-x-1.5">
                  {i > 0 ? <span aria-hidden>/</span> : null}
                  <span>{part}</span>
                </li>
              ))
            ) : (
              <li>Not in a category</li>
            )}
            {paths.length > 1 ? (
              <li className="ml-1.5" title={paths.slice(1).join("; ")}>
                (also in {paths.slice(1).join(" · ")})
              </li>
            ) : null}
          </ol>
        </nav>
        <h2
          ref={titleRef}
          id={titleId}
          tabIndex={-1}
          className="rounded-sm font-display text-xl font-semibold leading-snug tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {doc.title}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={`/kb/${doc.documentId}`} className="btn-primary gap-1.5 px-3 py-1 text-xs">
            Open source
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <KbDocPersonalActions personal={personal} />
        </div>
        {tags.length > 0 || updatedAt ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {tags.length > 0 ? <span className="sr-only">Tags:</span> : null}
            {tags.map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
            {updatedAt ? (
              <span>
                Updated <RelativeTime iso={updatedAt} />
              </span>
            ) : null}
          </div>
        ) : null}
        <KbDocNoteCard personal={personal} className="mt-3" />
        <div className="mt-3 border-t border-border pt-1 text-sm">
          {body.status === "loading" ? (
            <div className="mt-3 flex flex-col gap-2" aria-hidden>
              <div className="skeleton h-4 w-full" />
              <div className="skeleton h-4 w-5/6" />
              <div className="skeleton h-4 w-2/3" />
            </div>
          ) : body.status === "error" ? (
            <p role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {body.message}
            </p>
          ) : body.doc.markdown ? (
            <DocMarkdown markdown={body.doc.markdown} citationTarget={null} />
          ) : (
            <p className="mt-3 text-muted-foreground">This document has no readable content yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
