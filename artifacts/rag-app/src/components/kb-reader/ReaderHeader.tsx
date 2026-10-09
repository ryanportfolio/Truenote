import { useCallback, useEffect, useRef, type RefObject } from "react";
import { Link } from "wouter";
import { Star } from "lucide-react";
import type { KbDocPersonal } from "@/components/kb-library/KbDocPersonalBar";
import { useStuck } from "@/lib/useStuck";
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
 * 768px the header is not sticky and the padding is just the gap. The
 * header's height is also kept in `--kb-reader-header` for the sticky side
 * column.
 */
function useScrollPaddingBelow(headerRef: RefObject<HTMLElement>): void {
  useEffect(() => {
    const header = headerRef.current;
    const pane = header ? scrollParent(header) : null;
    if (!header || !pane) return;
    const before = pane.style.scrollPaddingTop;
    const beforeHeight = pane.style.getPropertyValue("--kb-reader-header");
    function update(): void {
      if (!header || !pane) return;
      const sticky = getComputedStyle(header).position === "sticky";
      const height = sticky ? Math.ceil(header.getBoundingClientRect().height) : 0;
      pane.style.scrollPaddingTop = `${height + SCROLL_GAP_PX}px`;
      pane.style.setProperty("--kb-reader-header", `${height}px`);
    }
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      pane.style.scrollPaddingTop = before;
      pane.style.setProperty("--kb-reader-header", beforeHeight);
    };
  }, [headerRef]);
}

/**
 * Sticky reader header: where the source lives (Sources / folder /
 * subfolder), one line, so the pinned band stays short. Sticky from 768px
 * up; on phones it scrolls away so the document gets the screen. Once pinned
 * it gets the same frosted, fading band as the Sources search bar. The
 * personal actions live at the top of the side column (ReaderActions).
 */
export function ReaderHeader({
  crumbs,
  otherPaths
}: {
  crumbs: ReaderCrumb[];
  /** Other folders the source is also in ("Retention"), each a link to that folder. */
  otherPaths: ReaderCrumb[];
}): JSX.Element {
  const headerRef = useRef<HTMLDivElement | null>(null);
  useScrollPaddingBelow(headerRef);
  const { ref: stuckRef, stuck } = useStuck();
  const setHeader = useCallback(
    (el: HTMLDivElement | null) => {
      headerRef.current = el;
      stuckRef(el);
    },
    [stuckRef]
  );
  return (
    <div
      ref={setHeader}
      data-kb-reader-header
      data-stuck={stuck || undefined}
      className="sticky-band relative z-20 -mx-3 px-3 pb-3 pt-1 sm:-mx-6 sm:px-6 md:sticky md:top-0 md:pt-4"
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
            <li data-kb-also-in className="text-xs">
              (also in{" "}
              {otherPaths.map((path, index) => (
                <span key={`${path.id ?? path.name}-${index}`}>
                  {index > 0 ? ", " : null}
                  {path.id ? (
                    <Link
                      href={`/kb?folder=${encodeURIComponent(path.id)}`}
                      className="rounded-sm underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {path.name}
                    </Link>
                  ) : (
                    path.name
                  )}
                </span>
              ))}
              )
            </li>
          ) : null}
        </ol>
      </nav>
    </div>
  );
}

/**
 * The reader's two personal actions, each a labeled button: keep it in my
 * shortcuts and a color label. Shown at the top of the side column. On phones
 * they shrink to short pills ("Shortcut", "Label") whose accessible names keep
 * the full wording. While the note editor is open, "Save note" is the one
 * filled button, so the shortcut button turns quiet until the editor closes.
 */
export function ReaderActions({
  personal,
  labels,
  labelsReady,
  onRenameLabel
}: {
  personal: KbDocPersonal;
  labels: KbColorLabel[];
  /** False while the user's labels are still loading. */
  labelsReady: boolean;
  onRenameLabel: SaveLabelName;
}): JSX.Element {
  const { item, editing } = personal;
  const inShortcuts = item.pinnedAt !== null;
  const shortcutName = inShortcuts ? "In my shortcuts" : "Add to my shortcuts";
  return (
    <div data-kb-reader-actions className="flex flex-nowrap items-center gap-1.5 sm:flex-wrap sm:gap-2.5">
      <button
        type="button"
        aria-pressed={inShortcuts}
        aria-label={shortcutName}
        data-kb-reader-shortcut
        onClick={() => void personal.togglePin()}
        title={inShortcuts ? "Remove it from your shortcuts" : "Keep it in your shortcuts on Sources"}
        className={cn(
          "shrink-0 gap-1.5 px-2.5 py-1.5 text-[13px] sm:gap-2 sm:px-4 sm:py-2 sm:text-sm",
          inShortcuts || editing ? "btn-whisper text-primary" : "btn-primary"
        )}
      >
        <Star className="h-4 w-4" fill={inShortcuts ? "currentColor" : "none"} aria-hidden />
        <span className="sm:hidden">Shortcut</span>
        <span className="hidden sm:inline">{shortcutName}</span>
      </button>
      <ReaderLabelMenu
        value={item.myColor}
        labels={labels}
        labelsReady={labelsReady}
        onSelect={(color) => void personal.setColor(color)}
        onRename={onRenameLabel}
      />
    </div>
  );
}
