import { Link } from "wouter";
import { Bookmark, Ellipsis, FolderInput, Megaphone, NotebookPen, PanelRightOpen, Tags } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import { categoryPathLabel, docCategoryPaths } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbMenu, type KbMenuEntry } from "./KbMenu";
import {
  DocCounts,
  NewBadge,
  NoteCard,
  myColorEntries,
  PinToggle,
  SourceColorLabel,
  SourceColorMenu,
  SourceColorStripe,
  TagChips
} from "./KbShared";

/**
 * Personal actions (pin, note, my color) and, for managers, library actions
 * shared by every row menu. My color is here too because the row's own color
 * button hides on phones.
 */
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
      icon: NotebookPen,
      onSelect: () => openDialog({ kind: "note", documentId: doc.documentId })
    },
    "separator",
    ...myColorEntries(doc.myColor, (color) => actions.setSourceColor(doc.documentId, color))
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

/** "Billing / Refunds · Retention", or the first two paths plus "+N more". */
export function pathsLabel(paths: string[]): string {
  if (paths.length <= 2) return paths.join(" · ");
  return `${paths.slice(0, 2).join(" · ")} +${paths.length - 2} more`;
}

/**
 * One source in a browse list. The title is a stretched link so the whole
 * row opens the reader; note, pin, color and menu sit above it on their own
 * layer.
 *
 * Under the title: the category path when the row stands outside its folder
 * (List view, search results), or "Also in ..." when a grouped view lists the
 * same source under another category too.
 */
export function KbDocRow({
  doc,
  showPath = false,
  inCategoryId = null,
  roundedEdges = false
}: {
  doc: KbDocumentListItem;
  showPath?: boolean;
  /** The category this row is listed under in Folders or Categories view. */
  inCategoryId?: string | null;
  /** Round the hover wash on the first and last row when the list is the whole card. */
  roundedEdges?: boolean;
}): JSX.Element {
  const { lookup, actions, openDialog, quickLook } = useKbLibraryContext();
  const menu = useDocMenuEntries(doc);
  const previewing = quickLook?.documentId === doc.documentId;
  const paths = docCategoryPaths(doc, lookup.tree);
  const elsewhere =
    !showPath && inCategoryId
      ? doc.categoryIds
          .filter((id) => id !== inCategoryId)
          .map((id) => lookup.tree.byId.get(id))
          .filter((node): node is NonNullable<typeof node> => Boolean(node))
          .map((node) => categoryPathLabel(node))
      : [];

  return (
    <li
      data-kb-row={doc.documentId}
      data-kb-previewing={previewing || undefined}
      className={cn(
        "relative px-4 py-2 transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40",
        previewing && "bg-primary/5 hover:bg-primary/5",
        roundedEdges && "first:rounded-t-lg last:rounded-b-lg"
      )}
    >
      <SourceColorStripe color={doc.myColor} />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 py-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/kb/${doc.documentId}`}
              className="rounded-sm text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {doc.title}
            </Link>
            <SourceColorLabel color={doc.myColor} />
            {doc.isNew ? <NewBadge /> : null}
            <TagChips tagIds={doc.tagIds} tagsById={lookup.tagsById} />
          </div>
          {showPath && paths.length > 0 ? (
            <p data-kb-path className="mt-0.5 text-xs text-muted-foreground" title={paths.join("; ")}>
              <span className="sr-only">In </span>
              {pathsLabel(paths)}
            </p>
          ) : null}
          {elsewhere.length > 0 ? (
            <p data-kb-also className="mt-0.5 text-xs text-muted-foreground" title={elsewhere.join("; ")}>
              Also in {pathsLabel(elsewhere)}
            </p>
          ) : null}
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <DocCounts doc={doc} />
          {doc.updatedAt ? (
            <span className="ml-2 hidden w-28 text-right text-xs text-muted-foreground md:inline">
              <span className="sr-only">Updated </span>
              <RelativeTime iso={doc.updatedAt} />
            </span>
          ) : null}
          {quickLook ? (
            <button
              type="button"
              data-kb-quicklook-trigger={doc.documentId}
              onClick={() => quickLook.toggle(doc.documentId)}
              aria-label={`Quick look: ${doc.title}`}
              aria-expanded={previewing}
              aria-controls={quickLook.paneId}
              title={previewing ? "Close quick look" : "Quick look: preview beside the list"}
              className={cn("btn-icon h-8 w-8", previewing && "text-primary hover:text-primary")}
            >
              <PanelRightOpen className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
          <PinToggle doc={doc} onToggle={() => actions.togglePin(doc.documentId)} />
          <SourceColorMenu
            doc={doc}
            className="hidden sm:inline-flex"
            onSelect={(color) => actions.setSourceColor(doc.documentId, color)}
          />
          <KbMenu label={`More actions for ${doc.title}`} items={menu}>
            <Ellipsis className="h-4 w-4" aria-hidden />
          </KbMenu>
        </div>
      </div>
      <NoteCard doc={doc} onEdit={() => openDialog({ kind: "note", documentId: doc.documentId })} />
    </li>
  );
}
