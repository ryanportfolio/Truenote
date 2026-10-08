import { forwardRef, useEffect, useId, useRef, useState } from "react";
import { Link } from "wouter";
import { Pencil, Star } from "lucide-react";
import { KB_NUMBERED_PINS, docCategoryPaths, type KbShortcut } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import { useKbLibraryContext } from "./KbContext";
import { pathsLabel } from "./KbDocRow";
import { ColorDot, LabelChip } from "./KbShared";

/** Team shortcut: two people, the manager's pick for everyone. */
function TeamGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="6" cy="5.25" r="2.25" />
      <path d="M1.75 13.25c.4-2.3 2.1-3.75 4.25-3.75s3.85 1.45 4.25 3.75" />
      <path d="M10.5 3.2a2.25 2.25 0 0 1 0 4.1" />
      <path d="M12 9.8c1.25.5 2 1.75 2.25 3.45" />
    </svg>
  );
}

/** The user's own shortcut: the same star as the row toggle. */
function MineGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M8 1.6l1.9 3.95 4.3.55-3.15 2.98.8 4.27L8 11.27l-3.85 2.08.8-4.27L1.8 6.1l4.3-.55z" />
    </svg>
  );
}

/** Recently opened: a clock face with a turning-back arrow. */
function RecentGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.6 8a5.4 5.4 0 1 0 1.6-3.85" />
      <path d="M2.4 2.4v2.4h2.4" />
      <path d="M8 5.2V8l1.9 1.3" />
    </svg>
  );
}

const SHORTCUT_SOURCE = {
  team: { label: "From your team", detail: "Your manager added this for everyone.", Glyph: TeamGlyph, tone: "bg-primary/10 text-primary" },
  mine: { label: "Added by you", detail: "You added this to your shortcuts.", Glyph: MineGlyph, tone: "bg-amber-100 text-amber-700" },
  recent: { label: "Recently opened", detail: "You opened this lately.", Glyph: RecentGlyph, tone: "bg-muted text-muted-foreground" }
} as const;

function ShortcutTile({ shortcut, index }: { shortcut: KbShortcut; index: number }): JSX.Element {
  const { data, lookup } = useKbLibraryContext();
  const tipId = useId();
  const { doc } = shortcut;
  const number = index + 1;
  const source = SHORTCUT_SOURCE[shortcut.source];
  const paths = docCategoryPaths(doc, lookup.tree);
  const where = paths.length > 0 ? `In ${pathsLabel(paths)}` : "Not in a folder";
  return (
    <li
      data-kb-shortcut={number}
      data-kb-shortcut-source={shortcut.source}
      className="group/tile relative flex min-w-0 items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 shadow-card transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40 max-sm:w-52 max-sm:shrink-0"
    >
      {/* Above the tile link's click overlay so hovering the icon shows the card. */}
      <span
        aria-hidden
        className={cn("relative z-10 mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md", source.tone)}
        data-kb-shortcut-why={source.label}
      >
        <source.Glyph />
      </span>
      {/* The hover card: why the source is here and its folder. Shown on icon hover and on keyboard focus, below the tile (as wide as the tile, so it never runs past the page). */}
      <span
        id={tipId}
        role="tooltip"
        data-kb-shortcut-card
        className="pointer-events-none absolute inset-x-0 top-full z-30 mt-1 hidden rounded-md border border-border bg-card px-2.5 py-1.5 text-xs leading-snug text-foreground shadow-panel group-has-[[data-kb-shortcut-why]:hover]/tile:block group-has-[a:focus-visible]/tile:block motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100"
      >
        <span className="block font-medium">{source.label}</span>
        <span className="block text-muted-foreground">{source.detail}</span>
        <span data-kb-shortcut-path className="mt-1 block border-t border-border pt-1 text-muted-foreground">
          {where}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <Link
          href={`/kb/${doc.documentId}`}
          aria-keyshortcuts={number <= KB_NUMBERED_PINS ? String(number) : undefined}
          aria-describedby={tipId}
          title={`${doc.title}\n${where}`}
          className="line-clamp-2 break-words rounded-sm text-sm font-medium leading-snug text-foreground after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span className="sr-only">Shortcut {number}, {source.label.toLowerCase()}: </span>
          <span data-kb-title>{doc.title}</span>
          <span className="sr-only">, {where.charAt(0).toLowerCase() + where.slice(1)}.</span>
        </Link>
        <LabelChip color={doc.myColor} labels={data.labels} />
      </span>
    </li>
  );
}

/**
 * "Your shortcuts": one shelf of up to nine tiles, team shortcuts first, then
 * the user's own, then sources they opened lately. The number keys 1 to 9
 * still open the tiles in order (no visible numbers). Every tile stays in
 * view: from 640px a wrapping grid of tiles at least 13rem wide, so titles
 * get two full lines beside the icon; on phones a sideways row.
 */
export const KbShortcutShelf = forwardRef<
  HTMLElement,
  { shelf: KbShortcut[]; onEdit: () => void }
>(function KbShortcutShelf({ shelf, onEdit }, ref): JSX.Element {
  return (
    <section ref={ref} aria-labelledby="kb-shortcuts" data-kb-shelf className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="kb-shortcuts" className="text-xl font-semibold tracking-tight">
          Your shortcuts
        </h2>
        <button
          type="button"
          onClick={onEdit}
          data-kb-edit-shortcuts
          aria-label="Edit shortcuts"
          title="See and change your shortcuts"
          className="btn-whisper gap-1.5 px-3 py-1.5 text-sm"
        >
          <Pencil className="h-4 w-4" aria-hidden />
          Edit
        </button>
      </div>
      {shelf.length > 0 ? (
        <ol
          aria-label="Your shortcuts"
          className={cn(
            // Phones: one sideways-scrolling row. 640px and up: a wrapping grid, never a sideways scrollbar.
            "-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]",
            "sm:grid sm:grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] sm:overflow-visible"
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

/** Below this width per chip, dock chips show only their number (the title stays in the tooltip and the accessible name). */
const DOCK_CHIP_MIN_WIDTH = 100;

/**
 * The shelf, docked to the bottom of the viewport in one row once the shelf
 * has scrolled away. Sticky inside the page column, so at the end of the page
 * it sits after the last row instead of over it. Every chip stays whole: the
 * chips share the row and their titles shorten with an ellipsis (7rem at
 * most); when that would leave too little of each title, chips show only
 * their number. Phones that still run out of room scroll the row.
 */
export function KbShortcutDock({ shelf, shown }: { shelf: KbShortcut[]; shown: boolean }): JSX.Element {
  // Hidden, not unmounted: the page keeps the dock's space at its end, so the
  // dock can never cover the last row. inert keeps the hidden links out of Tab.
  const ref = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    ref.current?.toggleAttribute("inert", !shown);
  }, [shown]);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = (): void => setCompact(list.clientWidth / Math.max(1, shelf.length) < DOCK_CHIP_MIN_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [shelf.length]);
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
      <ul ref={listRef} data-kb-dock-compact={compact || undefined} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:thin]">
        {shelf.map(({ doc }, i) => (
          <li key={doc.documentId} className={compact ? "shrink-0" : "min-w-0"}>
            <Link
              href={`/kb/${doc.documentId}`}
              title={doc.title}
              aria-keyshortcuts={String(i + 1)}
              className="btn-base relative max-w-full gap-1.5 border border-border bg-secondary px-2.5 py-1 text-xs text-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span aria-hidden className="tabular-nums text-muted-foreground">
                {i + 1}
              </span>
              {doc.myColor ? <ColorDot color={doc.myColor} /> : null}
              <span className={compact ? "sr-only" : "min-w-0 max-w-[7rem] truncate"}>{doc.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
