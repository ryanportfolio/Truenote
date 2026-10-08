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

/**
 * Sticky reader header: where the source lives (Sources / folder / subfolder)
 * and the three personal actions, each a labeled button: keep it in my
 * shortcuts, write a private note, and a color label. Sticky from 768px up;
 * on phones it scrolls away so the document gets the screen.
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
  const { item } = personal;
  const inShortcuts = item.pinnedAt !== null;
  const hasNote = Boolean(item.note);
  return (
    <div
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
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          aria-pressed={inShortcuts}
          data-kb-reader-shortcut
          onClick={() => void personal.togglePin()}
          title={inShortcuts ? "Remove it from your shortcuts" : "Keep it in your shortcuts on Sources"}
          className={cn(
            "gap-2 px-3.5 py-2 sm:px-4",
            inShortcuts ? "btn-whisper text-primary" : "btn-primary"
          )}
        >
          <Star className="h-4 w-4" fill={inShortcuts ? "currentColor" : "none"} aria-hidden />
          {inShortcuts ? "In my shortcuts" : "Add to my shortcuts"}
        </button>
        <button
          type="button"
          data-kb-reader-note-button
          onClick={onNote}
          className="btn-whisper gap-2 px-3.5 py-2 sm:px-4"
        >
          <NotebookPen className="h-4 w-4" aria-hidden />
          {hasNote ? "Edit my note" : "Write a private note"}
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
