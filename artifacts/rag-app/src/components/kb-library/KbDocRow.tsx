import { useRef } from "react";
import { Link, useLocation } from "wouter";
import { Ellipsis, ExternalLink, FolderInput, Lock, NotebookPen, Star, Tags, Users } from "lucide-react";
import { docCategoryPaths, isRecommended } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbMenu, type KbMenuEntry } from "./KbMenu";
import { LabelChip, NOTE_STICKY_STYLE, StarToggle, StatusPill, labelEntries } from "./KbShared";

/**
 * Everything a row does besides open and star, in one menu: the private note,
 * the label, for supervisors recommending to their team, and for managers
 * recommending to everyone, folders and tags.
 */
export function useDocMenuEntries(doc: KbDocumentListItem): KbMenuEntry[] {
  const { data, actions, canOrganize, openDialog } = useKbLibraryContext();
  const [, navigate] = useLocation();
  const entries: KbMenuEntry[] = [
    {
      label: doc.note ? "Edit my note" : "Write a private note",
      icon: NotebookPen,
      onSelect: () => openDialog({ kind: "note", documentId: doc.documentId })
    },
    {
      label: doc.pinnedAt ? "Remove from my shortcuts" : "Add to my shortcuts",
      icon: Star,
      onSelect: () => actions.togglePin(doc.documentId)
    },
    "separator",
    ...labelEntries(
      doc.myColor,
      data.labels,
      (color) => actions.setSourceColor(doc.documentId, color),
      () => openDialog({ kind: "label-create", documentId: doc.documentId })
    )
  ];
  if (data.canPinForTeam) {
    entries.push(
      "separator",
      doc.teamPinPosition !== null
        ? {
            label: "Stop recommending to my team",
            icon: Users,
            onSelect: () => actions.removeMyTeamPin(doc.documentId)
          }
        : {
            label: "Recommend to my team",
            icon: Users,
            onSelect: () => actions.addMyTeamPin(doc.documentId)
          }
    );
  }
  if (canOrganize) {
    entries.push(
      "separator",
      doc.featuredPosition !== null
        ? {
            label: "Stop recommending to everyone",
            icon: Users,
            onSelect: () => actions.removeTeamPin(doc.documentId)
          }
        : {
            label: "Recommend to everyone",
            icon: Users,
            onSelect: () => actions.addTeamPin(doc.documentId)
          },
      {
        label: "Folders…",
        icon: FolderInput,
        onSelect: () => openDialog({ kind: "doc-categories", documentId: doc.documentId })
      },
      {
        label: "Tags…",
        icon: Tags,
        onSelect: () => openDialog({ kind: "doc-tags", documentId: doc.documentId })
      }
    );
  }
  entries.push("separator", {
    label: "Open",
    icon: ExternalLink,
    onSelect: () => navigate(`/kb/${doc.documentId}`)
  });
  return entries;
}

/** "Billing / Refunds · Retention", or the first two paths plus "+N more". */
export function pathsLabel(paths: string[]): string {
  if (paths.length <= 2) return paths.join(" · ");
  return `${paths.slice(0, 2).join(" · ")} +${paths.length - 2} more`;
}

/**
 * One source in any browse view, kept quiet: the title (a stretched link, so
 * the whole row opens the reader) with the user's label chip, one muted
 * line with its folder path, the private note as a one-line sticky, and on
 * the right at most one status pill, "Used often", the star and one menu.
 * A right-click anywhere on the row opens that menu at the pointer.
 */
export function KbDocRow({
  doc,
  usedOften = false,
  roundedEdges = false
}: {
  doc: KbDocumentListItem;
  /** One of the three most opened sources in the whole library (context usedOften). */
  usedOften?: boolean;
  /** Round the hover wash on the first and last row when the list is the whole card. */
  roundedEdges?: boolean;
  /** Kept for callers from earlier builds; every row names its folders now. */
  showPath?: boolean;
  inCategoryId?: string | null;
}): JSX.Element {
  const { data, lookup, actions, openDialog } = useKbLibraryContext();
  const menu = useDocMenuEntries(doc);
  const paths = docCategoryPaths(doc, lookup.tree);
  const recommended = isRecommended(doc);
  const rowRef = useRef<HTMLLIElement>(null);

  return (
    <li
      ref={rowRef}
      data-kb-row={doc.documentId}
      className={cn(
        // One grid so each part renders once: on phones the status drops under the title.
        "relative grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1 py-3 pl-5 pr-3 transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40",
        "sm:grid-cols-[minmax(0,1fr)_5rem_auto_auto] sm:gap-x-2 sm:pr-4 md:grid-cols-[minmax(0,1fr)_5rem_5rem_auto_auto]",
        roundedEdges && "first:rounded-t-lg last:rounded-b-lg"
      )}
    >
      <div className="col-start-1 row-start-1 min-w-0">
        <Link
          href={`/kb/${doc.documentId}`}
          data-kb-title
          className="rounded-sm text-base font-medium leading-snug text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {doc.title}
        </Link>
        <LabelChip color={doc.myColor} labels={data.labels} className="ml-2" />
        {doc.note ? (
          // As wide as the title column (up to the status column); two lines on phones, one from 640px.
          <button
            type="button"
            data-kb-note
            onClick={() => openDialog({ kind: "note", documentId: doc.documentId })}
            title={doc.note}
            aria-label={`My notes: ${doc.note}. Edit note`}
            className="relative z-10 mt-1 flex max-w-full cursor-pointer items-start gap-1.5 rounded-md px-2 py-0.5 text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:items-center"
            style={NOTE_STICKY_STYLE}
          >
            <Lock className="mt-[3px] h-3.5 w-3.5 shrink-0 text-foreground/70 sm:mt-0" aria-hidden />
            <span className="line-clamp-2 min-w-0 break-words sm:line-clamp-none sm:truncate">{doc.note}</span>
          </button>
        ) : null}
        <p data-kb-path className="mt-0.5 text-sm text-muted-foreground">
          <span className="sr-only">In </span>
          {paths.length > 0 ? pathsLabel(paths) : "Not in a folder"}
          {recommended ? <span data-kb-recommended> · Recommended</span> : null}
        </p>
      </div>
      {usedOften ? (
        <span
          data-kb-used-often
          className="hidden text-right text-sm text-muted-foreground md:col-start-2 md:row-start-1 md:block"
        >
          Used often
        </span>
      ) : null}
      <span className="col-start-1 row-start-2 mt-1 flex empty:hidden sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-center md:col-start-3">
        <StatusPill doc={doc} />
      </span>
      <span className="relative z-10 col-start-2 row-start-1 sm:col-start-3 md:col-start-4">
        <StarToggle doc={doc} onToggle={() => actions.togglePin(doc.documentId)} />
      </span>
      <span className="relative z-10 col-start-3 row-start-1 sm:col-start-4 md:col-start-5">
        <KbMenu
          label={`More actions for ${doc.title}`}
          title="More actions (or right-click)"
          items={menu}
          contextTarget={rowRef}
        >
          <Ellipsis className="h-5 w-5" aria-hidden />
        </KbMenu>
      </span>
    </li>
  );
}
