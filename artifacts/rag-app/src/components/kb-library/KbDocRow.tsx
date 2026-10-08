import { Link } from "wouter";
import {
  Bookmark,
  Ellipsis,
  FolderInput,
  Megaphone,
  StickyNote,
  Tags
} from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { categoryPathLabel } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbMenu, type KbMenuEntry } from "./KbMenu";
import { DocCounts, NewBadge, NoteIndicator, PinToggle, TagChips } from "./KbShared";

/** Personal and (for managers) library actions shared by every row menu. */
export function useDocMenuEntries(doc: KbDocumentListItem): KbMenuEntry[] {
  const { actions, canOrganize, openDialog } = useKbLibraryContext();
  const entries: KbMenuEntry[] = [
    {
      label: doc.pinnedAt ? "Remove from My pins" : "Add to My pins",
      icon: Bookmark,
      onSelect: () => actions.togglePin(doc.documentId)
    },
    {
      label: doc.note ? "Edit my note" : "Add a note",
      icon: StickyNote,
      onSelect: () => openDialog({ kind: "note", documentId: doc.documentId })
    }
  ];
  if (canOrganize) {
    entries.push(
      "separator",
      doc.featuredPosition !== null
        ? {
            label: "Remove team pin",
            icon: Megaphone,
            onSelect: () => actions.removeTeamPin(doc.documentId)
          }
        : {
            label: "Pin for the team",
            icon: Megaphone,
            onSelect: () => actions.addTeamPin(doc.documentId)
          },
      {
        label: "Categories…",
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
  return entries;
}

/**
 * One source in a browse list. The title is a stretched link so the whole
 * row opens the reader; pin, note and menu sit above it on their own layer.
 */
export function KbDocRow({
  doc,
  showPath = false,
  roundedEdges = false
}: {
  doc: KbDocumentListItem;
  showPath?: boolean;
  /** Round the hover wash on the first and last row when the list is the whole card. */
  roundedEdges?: boolean;
}): JSX.Element {
  const { lookup, actions, openDialog } = useKbLibraryContext();
  const menu = useDocMenuEntries(doc);
  const paths = showPath
    ? doc.categoryIds
        .map((id) => categoryPathLabel(lookup.tree.byId.get(id)))
        .filter(Boolean)
    : [];

  return (
    <li
      className={cn(
        "relative flex items-center gap-3 px-4 py-2 transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40",
        roundedEdges && "first:rounded-t-lg last:rounded-b-lg"
      )}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            href={`/kb/${doc.documentId}`}
            className="rounded-sm text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {doc.title}
          </Link>
          {doc.isNew ? <NewBadge /> : null}
          <TagChips tagIds={doc.tagIds} tagsById={lookup.tagsById} />
        </div>
        {paths.length > 0 ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={paths.join("; ")}>
            <span className="sr-only">In </span>
            {paths[0]}
            {paths.length > 1 ? ` and ${paths.length - 1} more` : ""}
          </p>
        ) : null}
      </div>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        <DocCounts doc={doc} />
        {doc.updatedAt ? (
          <span className="ml-2 hidden w-24 text-right text-xs text-muted-foreground md:inline">
            <RelativeTime iso={doc.updatedAt} />
          </span>
        ) : null}
        <NoteIndicator
          doc={doc}
          onOpen={() => openDialog({ kind: "note", documentId: doc.documentId })}
        />
        <PinToggle doc={doc} onToggle={() => actions.togglePin(doc.documentId)} />
        <KbMenu label={`More actions for ${doc.title}`} items={menu}>
          <Ellipsis className="h-4 w-4" aria-hidden />
        </KbMenu>
      </div>
    </li>
  );
}
