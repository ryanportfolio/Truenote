import { forwardRef, useEffect, useRef } from "react";
import { Link } from "wouter";
import { FileText, Star } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { KB_NUMBERED_PINS, type KbShortcut } from "@/lib/kbLibrary";
import { kbColorDot } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import { useKbLibraryContext } from "./KbContext";
import { ColorDot, SourceColorLabel } from "./KbShared";

/** "From your team", "Pinned by you" or "Opened 1 hour ago". */
function ShortcutSource({ shortcut }: { shortcut: KbShortcut }): JSX.Element {
  if (shortcut.source === "team") return <>From your team</>;
  if (shortcut.source === "mine") return <>Pinned by you</>;
  return (
    <>
      Opened <RelativeTime iso={shortcut.doc.lastViewedByMeAt as string} />
    </>
  );
}

function ShortcutTile({ shortcut, index }: { shortcut: KbShortcut; index: number }): JSX.Element {
  const { data } = useKbLibraryContext();
  const { doc } = shortcut;
  const number = index + 1;
  return (
    <li
      data-kb-shortcut={number}
      data-kb-shortcut-source={shortcut.source}
      className="relative flex min-w-0 flex-col rounded-lg border border-border bg-card px-2.5 pb-3 pt-2 shadow-card transition-colors duration-100 ease-out focus-within:z-20 hover:bg-muted/40 max-sm:w-40 max-sm:shrink-0 lg:min-w-[7rem] lg:flex-1 lg:basis-0"
    >
      {doc.myColor ? (
        <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-r-full" style={kbColorDot(doc.myColor)} />
      ) : null}
      <span className="flex items-center justify-between gap-2 text-muted-foreground">
        <FileText className="h-4 w-4 shrink-0" aria-hidden />
        <span aria-hidden className="text-xs font-medium tabular-nums">
          {number}
        </span>
      </span>
      <span className="mt-1.5 line-clamp-2 text-xs text-muted-foreground" data-kb-shortcut-why>
        <ShortcutSource shortcut={shortcut} />
      </span>
      <Link
        href={`/kb/${doc.documentId}`}
        aria-keyshortcuts={number <= KB_NUMBERED_PINS ? String(number) : undefined}
        title={doc.title}
        className="mt-0.5 line-clamp-3 break-words rounded-sm text-sm font-medium leading-snug text-foreground after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="sr-only">Shortcut {number}: </span>
        <span data-kb-title>{doc.title}</span>
        <SourceColorLabel color={doc.myColor} labels={data.labels} />
      </Link>
    </li>
  );
}

/**
 * "Your shortcuts": one shelf of up to nine tiles, team shortcuts first, then
 * the user's own, then sources they opened lately. Each tile has the number
 * key that opens it. Tiles share one row from 1024px (scrolling sideways when
 * they do not fit), wrap below that, and scroll sideways on phones.
 */
export const KbShortcutShelf = forwardRef<
  HTMLElement,
  { shelf: KbShortcut[]; onEdit: () => void }
>(function KbShortcutShelf({ shelf, onEdit }, ref): JSX.Element {
  return (
    <section ref={ref} aria-labelledby="kb-shortcuts" data-kb-shelf className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 id="kb-shortcuts" className="text-xl font-semibold tracking-tight">
            Your shortcuts
          </h2>
          {shelf.length > 0 ? (
            <p data-kb-pin-hint className="hidden text-xs text-muted-foreground sm:block [@media(pointer:coarse)]:hidden">
              Press <kbd className="kbd">1</kbd>
              {shelf.length > 1 ? (
                <>
                  {" "}to <kbd className="kbd">{shelf.length}</kbd>
                </>
              ) : null}{" "}
              to open one.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onEdit}
          data-kb-edit-shortcuts
          className="cursor-pointer rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Edit shortcuts
        </button>
      </div>
      {shelf.length > 0 ? (
        <ol
          aria-label="Your shortcuts"
          className={cn(
            // Phones: one sideways-scrolling row. 640 to 1023px: wraps. 1024px and up: one row of equal tiles.
            "-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]",
            "sm:grid sm:grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] sm:overflow-visible",
            "lg:flex lg:overflow-x-auto"
          )}
        >
          {shelf.map((shortcut, i) => (
            <ShortcutTile key={shortcut.doc.documentId} shortcut={shortcut} index={i} />
          ))}
        </ol>
      ) : (
        <p className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
          <Star className="h-4 w-4 shrink-0" aria-hidden />
          Star a source to keep it here. Each shortcut gets a number key that opens it.
        </p>
      )}
    </section>
  );
});

/**
 * The shelf, docked to the bottom of the viewport in one row once the shelf
 * has scrolled away. Sticky inside the page column, so at the end of the page
 * it sits after the last row instead of over it.
 */
export function KbShortcutDock({ shelf, shown }: { shelf: KbShortcut[]; shown: boolean }): JSX.Element {
  // Hidden, not unmounted: the page keeps the dock's space at its end, so the
  // dock can never cover the last row. inert keeps the hidden links out of Tab.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.toggleAttribute("inert", !shown);
  }, [shown]);
  return (
    <nav
      data-kb-dock={shown ? "shown" : "hidden"}
      aria-label="Your shortcuts"
      ref={ref}
      aria-hidden={!shown || undefined}
      className={cn(
        "sticky bottom-3 z-30 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 shadow-panel motion-safe:transition-[opacity,transform] motion-safe:duration-240 motion-safe:ease-out-quart",
        shown ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0"
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Star className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
        <span className="hidden sm:inline">Shortcuts</span>
      </span>
      <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none]">
        {shelf.map(({ doc }, i) => (
          <li key={doc.documentId} className="shrink-0">
            <Link
              href={`/kb/${doc.documentId}`}
              title={doc.title}
              aria-keyshortcuts={String(i + 1)}
              className="btn-base gap-1.5 border border-border bg-secondary px-2.5 py-1 text-xs text-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span aria-hidden className="tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              {doc.myColor ? <ColorDot color={doc.myColor} /> : null}
              <span className="max-w-[12rem] truncate">{doc.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
