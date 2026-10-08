import { useId, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight, Palette, Undo2 } from "lucide-react";
import {
  KB_UNCATEGORIZED,
  docsInFolder,
  docsWithoutFolder,
  folderParam,
  libraryOrder,
  memberOrder,
  mostUsed,
  myPins,
  sortDocs,
  subtreeDocumentIds,
  teamPins,
  type KbCategoryNode,
  type KbSort,
  type KbTree
} from "@/lib/kbLibrary";
import { kbColorLabel, kbEffectiveCategoryColor } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbCategory, KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbDocRow } from "./KbDocRow";
import { KbMenu } from "./KbMenu";
import { FolderGlyph } from "./KbShared";

export const UNCATEGORIZED_KEY = KB_UNCATEGORIZED;

interface BrowseProps {
  /** Sources that pass the current search and filters. */
  visible: KbDocumentListItem[];
  sort: KbSort;
  /** True while a search or filter narrows the list: every folder opens and empty ones hide. */
  filtering: boolean;
}

function sortInCategory(
  docs: KbDocumentListItem[],
  sort: KbSort,
  node: KbCategoryNode | null
): KbDocumentListItem[] {
  if (sort !== "manual") return sortDocs(docs, sort);
  // Sources outside any folder have no manager order; A to Z reads best.
  return node ? sortDocs(docs, "manual", memberOrder(node.category)) : sortDocs(docs, "title");
}

function directDocs(node: KbCategoryNode, byId: Map<string, KbDocumentListItem>): KbDocumentListItem[] {
  return node.category.documentIds
    .map((id) => byId.get(id))
    .filter((d): d is KbDocumentListItem => Boolean(d));
}

/** "10 sources": every source in the folder and the folders inside it (same meaning in Organize). */
export function CountLabel({ count, className }: { count: number; className?: string }): JSX.Element {
  return (
    <span
      className={cn("ml-auto shrink-0 whitespace-nowrap tabular-nums text-xs font-normal text-muted-foreground", className)}
    >
      {count} {count === 1 ? "source" : "sources"}
    </span>
  );
}

/** `/kb` link that opens a folder (or the cabinet for null), keeping any other query parameters. */
export function folderHref(search: string, scope: string | null): string {
  const params = new URLSearchParams(search);
  if (scope === null) params.delete("folder");
  else params.set("folder", folderParam(scope));
  const query = params.toString();
  return query ? `/kb?${query}` : "/kb";
}

/**
 * A folder's color for this user only, kept apart from the team color a
 * manager sets in Organize. The button names both so it is clear which one
 * is showing.
 */
export function FolderColorMenu({ category }: { category: KbCategory }): JSX.Element {
  const { actions } = useKbLibraryContext();
  const showing = category.myColor
    ? `my color, ${kbColorLabel(category.myColor)}`
    : `team color, ${kbColorLabel(category.color)}`;
  return (
    <KbMenu
      label={`Color for the folder ${category.name}. Showing ${showing}.`}
      title="Folder color (only you see it)"
      buttonClassName="btn-icon h-8 w-8 shrink-0"
      items={[
        {
          kind: "swatches",
          label: "My color",
          hint: "Only you can see this. It replaces the team color for you.",
          value: category.myColor,
          onSelect: (color) => actions.setCategoryColor(category.id, color)
        },
        {
          label: `Use team color (${kbColorLabel(category.color)})`,
          icon: Undo2,
          radio: true,
          checked: category.myColor === null,
          onSelect: () => {
            if (category.myColor !== null) actions.setCategoryColor(category.id, null);
          }
        }
      ]}
    >
      <Palette className="h-4 w-4" aria-hidden />
    </KbMenu>
  );
}

/** Quiet rows in one card; "Used often" marks the three most opened sources of the whole library. */
export function KbRows({ docs, label }: { docs: KbDocumentListItem[]; label: string }): JSX.Element {
  const { usedOften: often } = useKbLibraryContext();
  return (
    <ul aria-label={label} className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
      {docs.map((doc) => (
        <KbDocRow key={doc.documentId} doc={doc} usedOften={often.has(doc.documentId)} roundedEdges />
      ))}
    </ul>
  );
}

/** Rows of a list in the chosen sort; the manager's order follows the folder (or the whole library). */
function listOrder(
  docs: KbDocumentListItem[],
  sort: KbSort,
  node: KbCategoryNode | null,
  tree: KbTree,
  acrossFolders: boolean
): KbDocumentListItem[] {
  if (sort !== "manual") return sortDocs(docs, sort);
  if (node && !acrossFolders) return sortInCategory(docs, sort, node);
  return sortDocs(docs, "manual", libraryOrder(tree));
}

/** The folders above this one, top level first. */
function ancestorsOf(node: KbCategoryNode, tree: KbTree): KbCategoryNode[] {
  const chain: KbCategoryNode[] = [];
  let parentId = node.category.parentId;
  while (parentId) {
    const parent = tree.byId.get(parentId);
    if (!parent || chain.includes(parent)) break;
    chain.unshift(parent);
    parentId = parent.category.parentId;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Folders view: the file cabinet

function FolderCard({
  node,
  visible,
  search
}: {
  node: KbCategoryNode | null;
  visible: KbDocumentListItem[];
  search: string;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const docs = node ? docsInFolder(visible, node) : docsWithoutFolder(visible, lookup.tree);
  const top = mostUsed(docs, 2);
  const name = node ? node.category.name : "Not in a folder";
  const scope = node ? node.category.id : KB_UNCATEGORIZED;
  return (
    <li
      data-kb-folder-card={scope}
      className="relative flex min-w-0 flex-col rounded-lg border border-border bg-card p-4 shadow-card transition-colors duration-100 ease-out focus-within:border-primary/50 hover:border-primary/40"
    >
      <div className="flex items-center gap-3">
        <FolderGlyph color={node ? kbEffectiveCategoryColor(node.category) : null} className="h-10 w-10" />
        <div className="min-w-0">
          <Link
            href={folderHref(search, scope)}
            className="block rounded-sm text-base font-medium text-foreground after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <span className="sr-only">Open folder </span>
            {name}
          </Link>
          <p className="text-sm text-muted-foreground">
            {docs.length} {docs.length === 1 ? "source" : "sources"}
          </p>
        </div>
      </div>
      {top.length > 0 ? (
        <ul aria-label={`Most used in ${name}`} className="relative z-10 mt-3 flex flex-col">
          {top.map((doc) => (
            <li key={doc.documentId}>
              <Link
                href={`/kb/${doc.documentId}`}
                className="flex items-center justify-between gap-2 rounded-sm py-1 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 truncate">{doc.title}</span>
                <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">No sources yet.</p>
      )}
    </li>
  );
}

/** Top-level folders as cards, "Not in a folder" last. */
function Cabinet({ visible, search }: { visible: KbDocumentListItem[]; search: string }): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const loose = docsWithoutFolder(visible, lookup.tree);
  return (
    <ul aria-label="Folders" data-kb-cabinet className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {lookup.tree.roots.map((node) => (
        <FolderCard key={node.category.id} node={node} visible={visible} search={search} />
      ))}
      {loose.length > 0 ? <FolderCard node={null} visible={visible} search={search} /> : null}
    </ul>
  );
}

/** An open folder: breadcrumb, title and count, subfolder chips, then its sources (folders inside included). */
function OpenFolder({
  scope,
  visible,
  sort,
  filtering,
  search
}: BrowseProps & { scope: string; search: string }): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const headingId = useId();
  const node = scope === KB_UNCATEGORIZED ? null : lookup.tree.byId.get(scope) ?? null;
  const docs = node ? docsInFolder(visible, node) : docsWithoutFolder(visible, lookup.tree);
  const rows = listOrder(docs, sort, node, lookup.tree, Boolean(node && node.children.length > 0));
  const ancestors = node ? ancestorsOf(node, lookup.tree) : [];
  const name = node ? node.category.name : "Not in a folder";

  return (
    <section aria-labelledby={headingId} data-kb-open-folder={scope} className="flex flex-col gap-3">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <li>
            <Link href={folderHref(search, null)} className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              All folders
            </Link>
          </li>
          {ancestors.map((a) => (
              <li key={a.category.id} className="flex items-center gap-2">
                <span aria-hidden className="text-muted-foreground">/</span>
                <Link
                  href={folderHref(search, a.category.id)}
                  className="rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {a.category.name}
                </Link>
              </li>
          ))}
          <li className="flex items-center gap-2">
            <span aria-hidden className="text-muted-foreground">/</span>
            <span aria-current="page" className="font-medium text-foreground">
              {name}
            </span>
          </li>
        </ol>
      </nav>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2
            id={headingId}
            tabIndex={-1}
            data-kb-folder-title
            className="min-w-0 font-display text-3xl font-semibold tracking-tight focus:outline-none"
          >
            {name}
          </h2>
          {node ? <FolderColorMenu category={node.category} /> : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {filtering
            ? `${docs.length} matching ${docs.length === 1 ? "source" : "sources"}`
            : `${docs.length} ${docs.length === 1 ? "source" : "sources"}`}
        </p>
      </div>
      {node && node.children.length > 0 ? (
        <nav aria-label={`Folders in ${name}`}>
          <ul className="flex flex-wrap gap-2">
            <li>
              <span
                aria-current="page"
                className="btn-base border border-primary bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground"
              >
                All
              </span>
            </li>
            {node.children.map((child) => (
              <li key={child.category.id}>
                <Link
                  href={folderHref(search, child.category.id)}
                  data-kb-subfolder={child.category.id}
                  className="btn-whisper px-4 py-1.5 text-sm"
                >
                  {child.category.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {rows.length > 0 ? (
        <KbRows docs={rows} label={`Sources in ${name}`} />
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {filtering ? "No sources in this folder match." : "No sources in this folder yet."}
        </p>
      )}
    </section>
  );
}

/**
 * Folders view (default): the cabinet of folder cards, or one open folder
 * (`?folder=<id>`). While a search or filter narrows the list, the cabinet
 * gives way to the matching rows so results are never hidden in a card.
 */
export function KbFoldersView({
  scope,
  search,
  ...props
}: BrowseProps & {
  /** The open folder (KB_UNCATEGORIZED for no folder), or null for the cabinet. */
  scope: string | null;
  /** The page's query string, so folder links keep other parameters. */
  search: string;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  if (scope !== null) return <OpenFolder scope={scope} search={search} {...props} />;
  if (props.filtering || lookup.tree.roots.length === 0) {
    return <KbRows docs={listOrder(props.visible, props.sort, null, lookup.tree, true)} label="Sources" />;
  }
  return <Cabinet visible={props.visible} search={search} />;
}

// ---------------------------------------------------------------------------
// Outline view: the nested tree

function Disclosure({
  label,
  count,
  open,
  onToggle,
  children,
  leading,
  trailing
}: {
  label: ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  leading?: ReactNode;
  /** Controls beside the toggle (not inside it). */
  trailing?: ReactNode;
}): JSX.Element {
  const panelId = useId();
  return (
    <>
      <div className="flex items-center transition-colors duration-100 ease-out hover:bg-muted/40">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-4 py-2.5 text-left text-base font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-100",
              open && "rotate-90"
            )}
            aria-hidden
          />
          {leading}
          <span className="min-w-0 truncate">{label}</span>
          <CountLabel count={count} className="text-sm" />
        </button>
        {trailing ? <span className="shrink-0 pr-2">{trailing}</span> : null}
      </div>
      <div id={panelId} hidden={!open}>
        {open ? children : null}
      </div>
    </>
  );
}

function OutlineNode({
  node,
  byId,
  props,
  often,
  collapsed,
  onToggle
}: {
  node: KbCategoryNode;
  byId: Map<string, KbDocumentListItem>;
  props: BrowseProps;
  often: Set<string>;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}): JSX.Element | null {
  let count = 0;
  subtreeDocumentIds(node).forEach((id) => {
    if (byId.has(id)) count += 1;
  });
  if (props.filtering && count === 0) return null;
  const open = props.filtering || !collapsed.has(node.category.id);
  const docs = sortInCategory(directDocs(node, byId), props.sort, node);
  return (
    <li>
      <Disclosure
        label={node.category.name}
        count={count}
        open={open}
        onToggle={() => onToggle(node.category.id)}
        leading={<FolderGlyph color={kbEffectiveCategoryColor(node.category)} className="h-5 w-5" />}
        trailing={<FolderColorMenu category={node.category} />}
      >
        <div className="ml-3 border-l border-border sm:ml-6">
          {node.children.length > 0 ? (
            <ul aria-label={`Folders in ${node.category.name}`} className="divide-y divide-border">
              {node.children.map((child) => (
                <OutlineNode
                  key={child.category.id}
                  node={child}
                  byId={byId}
                  props={props}
                  often={often}
                  collapsed={collapsed}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          ) : null}
          {docs.length > 0 ? (
            <ul
              aria-label={`Sources in ${node.category.name}`}
              className={cn("divide-y divide-border", node.children.length > 0 && "border-t border-border")}
            >
              {docs.map((doc) => (
                <KbDocRow key={doc.documentId} doc={doc} usedOften={often.has(doc.documentId)} />
              ))}
            </ul>
          ) : node.children.length === 0 ? (
            <p className="px-4 py-2 text-sm text-muted-foreground">No sources in this folder yet.</p>
          ) : null}
        </div>
      </Disclosure>
    </li>
  );
}

/** Outline view: nested folders in the manager's order, ending with sources in no folder. */
export function KbOutlineView({
  collapsed,
  onToggle,
  ...props
}: BrowseProps & {
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { lookup, usedOften: often } = useKbLibraryContext();
  const byId = new Map(props.visible.map((d) => [d.documentId, d]));
  const loose = sortInCategory(docsWithoutFolder(props.visible, lookup.tree), props.sort, null);

  if (lookup.tree.roots.length === 0) return <KbRows docs={loose} label="Sources" />;

  const looseOpen = props.filtering || !collapsed.has(UNCATEGORIZED_KEY);
  return (
    <div className="rounded-lg border border-border bg-card shadow-card">
      <ul aria-label="Folders" className="divide-y divide-border">
        {lookup.tree.roots.map((node) => (
          <OutlineNode
            key={node.category.id}
            node={node}
            byId={byId}
            props={props}
            often={often}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
        {loose.length > 0 ? (
          <li>
            <Disclosure
              label="Not in a folder"
              count={loose.length}
              open={looseOpen}
              onToggle={() => onToggle(UNCATEGORIZED_KEY)}
              leading={<FolderGlyph color={null} className="h-5 w-5" />}
            >
              <ul aria-label="Sources not in a folder" className="ml-3 divide-y divide-border border-l border-border sm:ml-6">
                {loose.map((doc) => (
                  <KbDocRow key={doc.documentId} doc={doc} usedOften={often.has(doc.documentId)} />
                ))}
              </ul>
            </Disclosure>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view and the My shortcuts tab

/** List view: every source in one sorted list. */
export function KbListView({ visible, sort }: BrowseProps): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const docs = sort === "manual" ? sortDocs(visible, "manual", libraryOrder(lookup.tree)) : sortDocs(visible, sort);
  return <KbRows docs={docs} label="Sources" />;
}

/** My shortcuts tab: the sources this user starred, in shelf order. Unstar to remove one. */
/**
 * Every shortcut in shelf order: the team's first, then the ones the user
 * added. A source that is both appears once, with the team's, as on the shelf.
 */
export function myShortcutGroups(visible: KbDocumentListItem[]): {
  team: KbDocumentListItem[];
  mine: KbDocumentListItem[];
} {
  const team = teamPins(visible);
  const teamIds = new Set(team.map((d) => d.documentId));
  return { team, mine: myPins(visible).filter((d) => !teamIds.has(d.documentId)) };
}

function ShortcutGroup({ title, docs }: { title: string; docs: KbDocumentListItem[] }): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-medium text-muted-foreground">
        {title} ({docs.length})
      </h3>
      <KbRows docs={docs} label={title} />
    </section>
  );
}

export function KbMyShortcuts({ visible, filtering }: { visible: KbDocumentListItem[]; filtering: boolean }): JSX.Element {
  const { team, mine } = myShortcutGroups(visible);
  return (
    <div className="flex flex-col gap-4" data-kb-my-shortcuts>
      {team.length > 0 ? <ShortcutGroup title="From your team" docs={team} /> : null}
      {mine.length > 0 ? <ShortcutGroup title="Added by you" docs={mine} /> : null}
      {team.length + mine.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {filtering ? "None of your shortcuts match." : "You have no shortcuts yet. Use the star on any source to add one."}
        </p>
      ) : null}
    </div>
  );
}
