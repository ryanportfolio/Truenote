import { useId, type ReactNode } from "react";
import { ChevronRight, Palette, Undo2 } from "lucide-react";
import {
  KB_UNCATEGORIZED,
  libraryOrder,
  memberOrder,
  sortDocs,
  subtreeDocumentIds,
  type KbCategoryNode,
  type KbSort
} from "@/lib/kbLibrary";
import { kbColorLabel, kbEffectiveCategoryColor } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbCategory, KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbDocRow } from "./KbDocRow";
import { KbMenu } from "./KbMenu";
import { ColorDot } from "./KbShared";

export const UNCATEGORIZED_KEY = KB_UNCATEGORIZED;

interface BrowseProps {
  /** Sources that pass the current search and filters. */
  visible: KbDocumentListItem[];
  sort: KbSort;
  /** True while a search or filter narrows the list: every folder opens and empty ones hide. */
  filtering: boolean;
  /** True while a search query is typed: rows name their category path, since results sit out of context. */
  searching: boolean;
}

function sortInCategory(
  docs: KbDocumentListItem[],
  sort: KbSort,
  node: KbCategoryNode | null
): KbDocumentListItem[] {
  if (sort !== "manual") return sortDocs(docs, sort);
  // Sources outside any category have no manager order; A to Z reads best.
  return node ? sortDocs(docs, "manual", memberOrder(node.category)) : sortDocs(docs, "title");
}

function directDocs(node: KbCategoryNode, byId: Map<string, KbDocumentListItem>): KbDocumentListItem[] {
  return node.category.documentIds
    .map((id) => byId.get(id))
    .filter((d): d is KbDocumentListItem => Boolean(d));
}

function uncategorized(visible: KbDocumentListItem[], known: Map<string, KbCategoryNode>): KbDocumentListItem[] {
  return visible.filter((d) => !d.categoryIds.some((id) => known.has(id)));
}

/** "10 sources": every source in the category and the categories inside it (same meaning in Organize). */
export function CountLabel({ count }: { count: number }): JSX.Element {
  return (
    <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-xs font-normal text-muted-foreground">
      {count} {count === 1 ? "source" : "sources"}
    </span>
  );
}

/**
 * Every user's private color for a category, kept apart from the team color
 * a manager sets in Organize mode. The button names both so it is clear
 * which one is showing.
 */
function CategoryColorMenu({ category }: { category: KbCategory }): JSX.Element {
  const { actions } = useKbLibraryContext();
  const showing = category.myColor
    ? `my color, ${kbColorLabel(category.myColor)}`
    : `team color, ${kbColorLabel(category.color)}`;
  return (
    <KbMenu
      label={`Color for ${category.name}. Showing ${showing}.`}
      title="Choose my color for this category"
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
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
          <CountLabel count={count} />
        </button>
        {trailing ? <span className="shrink-0 pr-2">{trailing}</span> : null}
      </div>
      <div id={panelId} hidden={!open}>
        {open ? children : null}
      </div>
    </>
  );
}

function FolderNode({
  node,
  byId,
  props,
  collapsed,
  onToggle
}: {
  node: KbCategoryNode;
  byId: Map<string, KbDocumentListItem>;
  props: BrowseProps;
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
        leading={<ColorDot color={kbEffectiveCategoryColor(node.category)} />}
        trailing={<CategoryColorMenu category={node.category} />}
      >
        <div className="ml-3 border-l border-border sm:ml-6">
          {node.children.length > 0 ? (
            <ul aria-label={`Categories in ${node.category.name}`} className="divide-y divide-border">
              {node.children.map((child) => (
                <FolderNode
                  key={child.category.id}
                  node={child}
                  byId={byId}
                  props={props}
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
                <KbDocRow
                  key={doc.documentId}
                  doc={doc}
                  inCategoryId={node.category.id}
                  showPath={props.searching}
                />
              ))}
            </ul>
          ) : node.children.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">No sources in this category yet.</p>
          ) : null}
        </div>
      </Disclosure>
    </li>
  );
}

/**
 * Folders view scoped by the category rail: a titled section for one
 * category (its subcategories as folders, then its own sources) or for the
 * sources in no category.
 */
function ScopedFolder({
  scope,
  props,
  collapsed,
  onToggle,
  onShowAll
}: {
  scope: string;
  props: BrowseProps;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onShowAll: () => void;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const headingId = useId();
  const byId = new Map(props.visible.map((d) => [d.documentId, d]));
  const node = scope === UNCATEGORIZED_KEY ? null : lookup.tree.byId.get(scope) ?? null;
  const loose = node ? [] : sortInCategory(uncategorized(props.visible, lookup.tree.byId), props.sort, null);
  let count = loose.length;
  if (node) {
    count = 0;
    subtreeDocumentIds(node).forEach((id) => {
      if (byId.has(id)) count += 1;
    });
  }
  const docs = node ? sortInCategory(directDocs(node, byId), props.sort, node) : loose;
  const parents = node ? node.path.slice(0, -1) : [];
  return (
    <section aria-labelledby={headingId} data-kb-scope={scope}>
      <div className="mb-2 flex items-center gap-2 px-1">
        {node ? (
          <ColorDot color={kbEffectiveCategoryColor(node.category)} />
        ) : (
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground" aria-hidden />
        )}
        <h2 id={headingId} className="min-w-0 font-display text-xl font-semibold tracking-tight">
          {parents.length > 0 ? (
            <span className="font-sans text-sm font-normal text-muted-foreground">{parents.join(" / ")} / </span>
          ) : null}
          {node ? node.category.name : "Not in a category"}
        </h2>
        <CountLabel count={count} />
        {node ? <CategoryColorMenu category={node.category} /> : null}
      </div>
      {count === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          {props.filtering ? "No sources here match the current search or filters." : "No sources in this category yet."}{" "}
          <button type="button" onClick={onShowAll} className="font-medium text-primary underline-offset-2 hover:underline">
            Show all sources
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card shadow-card">
          {node && node.children.length > 0 ? (
            <ul aria-label={`Categories in ${node.category.name}`} className="divide-y divide-border">
              {node.children.map((child) => (
                <FolderNode
                  key={child.category.id}
                  node={child}
                  byId={byId}
                  props={props}
                  collapsed={collapsed}
                  onToggle={onToggle}
                />
              ))}
            </ul>
          ) : null}
          {docs.length > 0 ? (
            <ul
              aria-label={node ? `Sources in ${node.category.name}` : "Sources not in a category"}
              className={cn("divide-y divide-border", node && node.children.length > 0 && "border-t border-border")}
            >
              {docs.map((doc) => (
                <KbDocRow
                  key={doc.documentId}
                  doc={doc}
                  inCategoryId={node?.category.id ?? null}
                  showPath={props.searching}
                  roundedEdges={!node || node.children.length === 0}
                />
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Nested folders in the manager's order, ending with sources not in any category. */
export function KbFoldersView({
  collapsed,
  onToggle,
  scope = null,
  onShowAll,
  ...props
}: BrowseProps & {
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  /** Category picked in the rail (UNCATEGORIZED_KEY for no category); null shows every folder. */
  scope?: string | null;
  onShowAll?: () => void;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const byId = new Map(props.visible.map((d) => [d.documentId, d]));
  const loose = sortInCategory(uncategorized(props.visible, lookup.tree.byId), props.sort, null);

  if (lookup.tree.roots.length === 0) return <KbPlainList docs={loose} />;
  if (scope !== null) {
    return (
      <ScopedFolder
        scope={scope}
        props={props}
        collapsed={collapsed}
        onToggle={onToggle}
        onShowAll={onShowAll ?? (() => undefined)}
      />
    );
  }

  const looseOpen = props.filtering || !collapsed.has(UNCATEGORIZED_KEY);
  return (
    <div className="rounded-lg border border-border bg-card shadow-card">
      <ul aria-label="Categories" className="divide-y divide-border">
        {lookup.tree.roots.map((node) => (
          <FolderNode
            key={node.category.id}
            node={node}
            byId={byId}
            props={props}
            collapsed={collapsed}
            onToggle={onToggle}
          />
        ))}
        {loose.length > 0 ? (
          <li>
            <Disclosure
              label="Not in a category"
              count={loose.length}
              open={looseOpen}
              onToggle={() => onToggle(UNCATEGORIZED_KEY)}
              leading={<span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground" aria-hidden />}
            >
              <ul aria-label="Sources not in a category" className="ml-3 divide-y divide-border border-l border-border sm:ml-6">
                {loose.map((doc) => (
                  <KbDocRow key={doc.documentId} doc={doc} />
                ))}
              </ul>
            </Disclosure>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function SectionCard({
  heading,
  action,
  children
}: {
  heading: ReactNode;
  /** Control beside the heading (not inside it). */
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-1.5 flex items-center gap-1 px-1">
        <h2 id={headingId} className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
          {heading}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One flat section per category (with its full path), then the uncategorized group. */
export function KbCategoriesView(props: BrowseProps): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const byId = new Map(props.visible.map((d) => [d.documentId, d]));
  const loose = sortInCategory(uncategorized(props.visible, lookup.tree.byId), props.sort, null);

  if (lookup.tree.roots.length === 0) return <KbPlainList docs={loose} />;

  return (
    <div className="flex flex-col gap-5">
      {lookup.tree.order.map((node) => {
        const docs = sortInCategory(directDocs(node, byId), props.sort, node);
        if (docs.length === 0) return null;
        const parents = node.path.slice(0, -1);
        return (
          <SectionCard
            key={node.category.id}
            heading={
              <>
                <ColorDot color={kbEffectiveCategoryColor(node.category)} />
                <span className="min-w-0">
                  {parents.length > 0 ? (
                    <span className="font-normal text-muted-foreground">{parents.join(" / ")} / </span>
                  ) : null}
                  {node.category.name}
                </span>
                <CountLabel count={docs.length} />
              </>
            }
            action={<CategoryColorMenu category={node.category} />}
          >
            <ul className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
              {docs.map((doc) => (
                <KbDocRow
                  key={doc.documentId}
                  doc={doc}
                  inCategoryId={node.category.id}
                  showPath={props.searching}
                  roundedEdges
                />
              ))}
            </ul>
          </SectionCard>
        );
      })}
      {loose.length > 0 ? (
        <SectionCard
          heading={
            <>
              <span className="text-muted-foreground">Not in a category</span>
              <CountLabel count={loose.length} />
            </>
          }
        >
          <ul className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
            {loose.map((doc) => (
              <KbDocRow key={doc.documentId} doc={doc} roundedEdges />
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </div>
  );
}

/** Everything in one sorted list, each row naming its category. */
export function KbListView({ visible, sort }: BrowseProps): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const docs = sort === "manual" ? sortDocs(visible, "manual", libraryOrder(lookup.tree)) : sortDocs(visible, sort);
  return <KbPlainList docs={docs} showPath={lookup.tree.roots.length > 0} />;
}

function KbPlainList({
  docs,
  showPath = false
}: {
  docs: KbDocumentListItem[];
  showPath?: boolean;
}): JSX.Element {
  return (
    <ul aria-label="Sources" className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
      {docs.map((doc) => (
        <KbDocRow key={doc.documentId} doc={doc} showPath={showPath} roundedEdges />
      ))}
    </ul>
  );
}
