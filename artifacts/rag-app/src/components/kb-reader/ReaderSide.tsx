import { useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Link } from "wouter";
import { FileText, Highlighter, Link2, ListTree, Lock, Pencil } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import type { KbDocPersonal } from "@/components/kb-library/KbDocPersonalBar";
import { NoteForm } from "@/components/kb-library/KbShared";
import { cn } from "@/lib/utils";

/** Soft yellow paper for the private note, from the personal annotation token. */
const NOTE_PAPER =
  "border border-[oklch(var(--highlight-yellow)/0.55)] bg-[oklch(var(--highlight-yellow)/0.18)]";

/**
 * "My private note" as a soft yellow card: the note, an edit pencil and who
 * can see it; edits in place. With no note it shows a short invitation and
 * the passage highlight hint (hidden below 1280px, where the header button
 * is the way in).
 */
export function ReaderNoteCard({
  personal,
  className
}: {
  personal: KbDocPersonal;
  className?: string;
}): JSX.Element {
  const { item, editing } = personal;
  const empty = !item.note && !editing;
  return (
    <section
      aria-labelledby="kb-reader-note-title"
      data-kb-note-card
      data-kb-reader-note
      className={cn("rounded-lg px-5 py-4 shadow-card", NOTE_PAPER, empty && "hidden xl:block", className)}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id="kb-reader-note-title" className="font-display text-lg font-semibold tracking-tight">
          My private note
        </h2>
        {item.note && !editing ? (
          <button
            ref={personal.editButtonRef}
            type="button"
            onClick={personal.startEditing}
            aria-label="Edit my note"
            title="Edit my note"
            className="btn-icon -mr-1 h-8 w-8 text-primary hover:text-primary"
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2">
          <NoteForm initialNote={item.note} autoFocus onCancel={personal.stopEditing} onSave={personal.saveNote} />
        </div>
      ) : item.note ? (
        <>
          <ClampedNote note={item.note} />
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 border-t border-[oklch(var(--highlight-yellow)/0.55)] pt-2.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            <span>Only you can see this.</span>
            {item.noteUpdatedAt ? (
              <span>
                Updated <RelativeTime iso={item.noteUpdatedAt} />.
              </span>
            ) : null}
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm leading-relaxed">
            Write down what you want to remember about this source, like the order you check things in.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            You can also select any passage in the document to highlight it.
          </p>
          <p className="mt-3 flex items-center gap-1.5 border-t border-[oklch(var(--highlight-yellow)/0.55)] pt-2.5 text-xs text-muted-foreground">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            Only you can see this.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The note text. On phones it shows 2 lines with "Show all", so the document
 * title still starts on the first screen; from 640px up it shows in full.
 */
function ClampedNote({ note }: { note: string }): JSX.Element {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textId = useId();

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    function measure(): void {
      if (!el) return;
      // Measured while clamped; the clamp only applies below 640px.
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    }
    if (!expanded) measure();
    const observer = new ResizeObserver(() => {
      if (!expanded) measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [note, expanded]);

  return (
    <>
      <p
        ref={textRef}
        id={textId}
        className={cn(
          "mt-2 whitespace-pre-wrap break-words text-[15px] leading-relaxed",
          !expanded && "max-sm:line-clamp-2"
        )}
      >
        {note}
      </p>
      {overflows || expanded ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((open) => !open)}
          className="mt-1 rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </>
  );
}

/**
 * One quiet line telling readers below 1280px that passages can be
 * highlighted (at 1280 and up the empty note card says it). It stays after
 * the first highlight is saved, so saving never moves the document up.
 */
export function ReaderHighlightHint(): JSX.Element {
  return (
    <p data-kb-highlight-hint className="flex items-center gap-2 px-1 text-sm text-muted-foreground xl:hidden">
      <Highlighter className="h-4 w-4 shrink-0" aria-hidden />
      Select any passage to highlight it.
    </p>
  );
}

export interface ReaderHeading {
  id: string;
  text: string;
}

/** Scroll to a section heading and move focus there, so keyboard users land on it too. */
export function goToHeading(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
  window.history.replaceState(window.history.state, "", `#${id}`);
}

/** "On this page": one link per section heading of the document. */
export function ReaderOutline({
  headings,
  className
}: {
  headings: ReaderHeading[];
  className?: string;
}): JSX.Element | null {
  if (headings.length === 0) return null;
  function onClick(event: MouseEvent<HTMLAnchorElement>, id: string): void {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    goToHeading(id);
  }
  return (
    <nav aria-labelledby="kb-reader-outline-title" data-kb-outline className={cn("xl:px-1", className)}>
      <h2
        id="kb-reader-outline-title"
        className="flex items-center gap-2 font-display text-base font-semibold tracking-tight xl:text-lg"
      >
        <ListTree className="h-4 w-4 text-muted-foreground" aria-hidden />
        On this page
      </h2>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 xl:ml-6 xl:flex-col xl:gap-y-1.5">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              onClick={(event) => onClick(event, heading.id)}
              className="rounded-sm text-[15px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface ReaderRelatedItem {
  documentId: string;
  title: string;
  path: string | null;
}

/** "Related sources": other sources in the same or a nearby folder, or with shared tags; closest first. */
export function ReaderRelated({
  items,
  className
}: {
  items: ReaderRelatedItem[];
  className?: string;
}): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="kb-related" data-kb-related className={cn("xl:px-1", className)}>
      <h2 id="kb-related" className="flex items-center gap-2 font-display text-base font-semibold tracking-tight xl:text-lg">
        <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden />
        Related sources
      </h2>
      <ul className="mt-2 flex flex-col gap-2.5 xl:ml-6">
        {items.map((item) => (
          <li key={item.documentId}>
            <Link
              href={`/kb/${item.documentId}`}
              data-kb-related-source={item.documentId}
              className="group inline-flex items-start gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <FileText className="mt-1 h-4 w-4 shrink-0 text-muted-foreground xl:hidden" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[15px] text-primary group-hover:underline">{item.title}</span>
                {item.path ? (
                  <span className="block text-xs text-muted-foreground">
                    <span className="sr-only">In </span>
                    {item.path}
                  </span>
                ) : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
