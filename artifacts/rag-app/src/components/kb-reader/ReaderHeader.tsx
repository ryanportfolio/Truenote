import { useEffect, useRef, type RefObject } from "react";
import { Link } from "wouter";
import { NotebookPen, Star } from "lucide-react";
import type { KbDocPersonal } from "@/components/kb-library/KbDocPersonalBar";
import { cn } from "@/lib/utils";
import type { KbColorLabel } from "@/types/api";
import { ReaderLabelMenu, type SaveLabelName } from "./ReaderLabelMenu";

export interface ReaderCrumb {
  /** Folder id for the Sources link, or null for a crumb without one. */
  id: string | null;
  name: string;
}

/** Space kept between the sticky header and anything scrolled to or focused. */
const SCROLL_GAP_PX = 16;

/** The nearest ancestor that scrolls vertically (the app's main pane). */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * While the reader is open, the scroll pane keeps a top padding equal to the
 * sticky header plus 16px. Browsers honor it for keyboard focus, "On this
 * page" jumps and cited passages, so nothing lands under the header. Below
 * 768px the header is not sticky and the padding is just the gap.
 */
function useScrollPaddingBelow(headerRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const header = headerRef.current;
    const pane = header ? scrollParent(header) : null;
    if (!header || !pane) return;
    const before = pane.style.scrollPaddingTop;
    function update(): void {
      if (!header || !pane) return;
      const sticky = getComputedStyle(header).position === "sticky";
      const height = sticky ? Math.ceil(header.getBoundingClientRect().height) : 0;
      pane.style.scrollPaddingTop = `${height + SCROLL_GAP_PX}px`;
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      pane.style.scrollPaddingTop = before;
    };
  }, [headerRef]);
}

/**
 * Sticky reader header: where the source lives (Sources / folder / subfolder)
 * and the three personal actions, each a labeled button: keep it in my
 * shortcuts, write a private note, and a color label. Sticky from 768px up;
 * on phones it scrolls away so the document gets the screen, and the three
 * actions shrink to one row of short pills ("Shortcut", "Note", "Label")
 * whose accessible names keep the full wording.
 */
export function ReaderHeader({
  crumbs,
  otherPaths,
  personal,
  labels,
  onRenameLabel,
  onNote
}: {
  crumbs: ReaderCrumb[];
  /** Other folders the source is also in ("Retention"). */
  otherPaths: string[];
  personal: KbDocPersonal;
  labels: KbColorLabel[];
  onRenameLabel: SaveLabelName;
  onNote: () => void;
}): JSX.Element {
  const headerRef = useRef<HTMLDivElement>(null);
  useScrollPaddingBelow(headerRef);
  const { item } = personal;
  const inShortcuts = item.pinnedAt !== null;
  const hasNote = Boolean(item.note);
  const shortcutName = inShortcuts ? "In my shortcuts" : "Add to my shortcuts";
  const noteName = hasNote ? "Edit my note" : "Write a private note";
  return (
    <div
      ref={headerRef}
      data-kb-reader-header
      className="z-20 -mx-4 bg-background px-4 pb-3 pt-1 sm:-mx-6 sm:px-6 md:sticky md:top-0 md:border-b md:border-border/70 md:pt-4"
    >
      <nav aria-label="Breadcrumb" data-kb-breadcrumb className="text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <li>
            <Link
              href="/kb"
              className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sources
            </Link>
          </li>
          {crumbs.map((crumb, index) => (
            <li key={`${crumb.id ?? crumb.name}-${index}`} className="flex items-center gap-x-2">
              <span aria-hidden>/</span>
              {crumb.id ? (
                <Link
                  href={`/kb?folder=${encodeURIComponent(crumb.id)}`}
                  className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {crumb.name}
                </Link>
              ) : (
                <span>{crumb.name}</span>
              )}
            </li>
          ))}
          {otherPaths.length > 0 ? (
            <li className="text-xs" title={otherPaths.join("; ")}>
              (also in {otherPaths.join(", ")})
            </li>
          ) : null}
        </ol>
      </nav>
      <div className="mt-2.5 flex flex-nowrap items-center gap-1.5 sm:mt-3 sm:flex-wrap sm:gap-2.5">
        <button
          type="button"
          aria-pressed={inShortcuts}
          aria-label={shortcutName}
          data-kb-reader-shortcut
          onClick={() => void personal.togglePin()}
          title={inShortcuts ? "Remove it from your shortcuts" : "Keep it in your shortcuts on Sources"}
          className={cn(
            "shrink-0 gap-1.5 px-2.5 py-1.5 text-[13px] sm:gap-2 sm:px-4 sm:py-2 sm:text-sm",
            inShortcuts ? "btn-whisper text-primary" : "btn-primary"
          )}
        >
          <Star className="h-4 w-4" fill={inShortcuts ? "currentColor" : "none"} aria-hidden />
          <span className="sm:hidden">Shortcut</span>
          <span className="hidden sm:inline">{shortcutName}</span>
        </button>
        <button
          type="button"
          aria-label={noteName}
          data-kb-reader-note-button
          onClick={onNote}
          className="btn-whisper shrink-0 gap-1.5 px-2.5 py-1.5 text-[13px] sm:gap-2 sm:px-4 sm:py-2 sm:text-sm"
        >
          <NotebookPen className="h-4 w-4" aria-hidden />
          <span className="sm:hidden">Note</span>
          <span className="hidden sm:inline">{noteName}</span>
        </button>
        <ReaderLabelMenu
          value={item.myColor}
          labels={labels}
          onSelect={(color) => void personal.setColor(color)}
          onRename={onRenameLabel}
        />
      </div>
    </div>
  );
}
