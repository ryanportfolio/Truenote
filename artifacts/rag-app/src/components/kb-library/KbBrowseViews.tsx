import { useId, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import {
  libraryOrder,
  memberOrder,
  sortDocs,
  subtreeDocumentIds,
  type KbCategoryNode,
  type KbSort
} from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbDocRow } from "./KbDocRow";
import { ColorDot } from "./KbShared";

export const UNCATEGORIZED_KEY = "__uncategorized";

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

function CountLabel({ count }: { count: number }): JSX.Element {
  return (
    <span className="ml-auto shrink-0 tabular-nums text-xs font-normal text-muted-foreground">
      {count}
      <span className="sr-only">{count === 1 ? " source" : " sources"}</span>
    </span>
  );
}

function Disclosure({
  label,
  count,
  open,
  onToggle,
  children,
  leading
}: {
  label: ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  leading?: ReactNode;
}): JSX.Element {
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-sm font-medium transition-colors duration-100 ease-out hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
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
        leading={<ColorDot color={node.category.color} />}
      >
        <div className="ml-6 border-l border-border">
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
                <KbDocRow key={doc.documentId} doc={doc} />
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

/** Nested folders in the manager's order, ending with sources not in any category. */
export function KbFoldersView({
  collapsed,
  onToggle,
  ...props
}: BrowseProps & { collapsed: Set<string>; onToggle: (key: string) => void }): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const byId = new Map(props.visible.map((d) => [d.documentId, d]));
  const loose = sortInCategory(uncategorized(props.visible, lookup.tree.byId), props.sort, null);

  if (lookup.tree.roots.length === 0) return <KbPlainList docs={loose} />;

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
              <ul aria-label="Sources not in a category" className="ml-6 divide-y divide-border border-l border-border">
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
  children
}: {
  heading: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="mb-1.5 flex items-center gap-2 px-1 text-sm font-medium">
        {heading}
      </h2>
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
                <ColorDot color={node.category.color} />
                <span className="min-w-0">
                  {parents.length > 0 ? (
                    <span className="font-normal text-muted-foreground">{parents.join(" / ")} / </span>
                  ) : null}
                  {node.category.name}
                </span>
                <CountLabel count={docs.length} />
              </>
            }
          >
            <ul className="divide-y divide-border rounded-lg border border-border bg-card shadow-card">
              {docs.map((doc) => (
                <KbDocRow key={doc.documentId} doc={doc} roundedEdges />
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
