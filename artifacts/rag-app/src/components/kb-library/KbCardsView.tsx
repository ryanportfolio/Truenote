import { useId, useRef, type KeyboardEvent } from "react";
import { Link } from "wouter";
import { Ellipsis } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import {
  KB_UNCATEGORIZED,
  docCategoryPaths,
  docsInScope,
  libraryOrder,
  sortDocs,
  subtreeDocumentIds,
  subtreeIds,
  type KbCategoryNode,
  type KbSort
} from "@/lib/kbLibrary";
import { kbColorDot, kbEffectiveCategoryColor } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { pathsLabel, useDocMenuEntries } from "./KbDocRow";
import { KbMenu } from "./KbMenu";
import {
  ColorDot,
  DocCounts,
  NewBadge,
  NoteIndicator,
  PinToggle,
  SourceColorLabel,
  SourceColorStripe,
  TagChips
} from "./KbShared";

/** One source as a card: path, title, tags, labeled counts, then pin, note and menu. */
function KbDocCard({ doc }: { doc: KbDocumentListItem }): JSX.Element {
  const { lookup, actions, openDialog } = useKbLibraryContext();
  const menu = useDocMenuEntries(doc);
  const path = pathsLabel(docCategoryPaths(doc, lookup.tree));
  return (
    <li
      data-kb-card={doc.documentId}
      className="relative flex min-w-0 flex-col rounded-lg border border-border bg-card px-4 py-3 shadow-card transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:border-foreground/20"
    >
      <SourceColorStripe color={doc.myColor} />
      {path ? (
        <p data-kb-path className="truncate text-xs text-muted-foreground" title={path}>
          <span className="sr-only">In </span>
          {path}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Not in a category</p>
      )}
      <div className="mt-0.5 flex min-w-0 items-start gap-2">
        <Link
          href={`/kb/${doc.documentId}`}
          className="min-w-0 flex-1 break-words rounded-sm text-sm font-medium leading-snug text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {doc.title}
        </Link>
        <SourceColorLabel color={doc.myColor} />
        {doc.isNew ? <NewBadge /> : null}
      </div>
      {doc.tagIds.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <TagChips tagIds={doc.tagIds} tagsById={lookup.tagsById} />
        </div>
      ) : null}
      <div className="relative z-10 mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-2">
        <DocCounts doc={doc} always />
        {doc.updatedAt ? (
          <span className="text-xs text-muted-foreground">
            Updated <RelativeTime iso={doc.updatedAt} />
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <NoteIndicator doc={doc} onOpen={() => openDialog({ kind: "note", documentId: doc.documentId })} />
          <PinToggle doc={doc} onToggle={() => actions.togglePin(doc.documentId)} />
          <KbMenu label={`More actions for ${doc.title}`} items={menu}>
            <Ellipsis className="h-4 w-4" aria-hidden />
          </KbMenu>
        </span>
      </div>
    </li>
  );
}

function countIn(node: KbCategoryNode, ids: Set<string>): number {
  let count = 0;
  subtreeDocumentIds(node).forEach((id) => {
    if (ids.has(id)) count += 1;
  });
  return count;
}

/**
 * Cards view: top-level categories as tabs (plus All), the chosen
 * category's subcategories as chips, then a grid of cards. Tab and chip are
 * saved with the user's other view settings.
 */
export function KbCardsView({
  visible,
  sort,
  tab,
  sub,
  onScope
}: {
  visible: KbDocumentListItem[];
  sort: KbSort;
  tab: string | null;
  sub: string | null;
  onScope: (tab: string | null, sub: string | null) => void;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const tree = lookup.tree;
  const panelId = useId();
  const tabsRef = useRef<HTMLDivElement>(null);
  const ids = new Set(visible.map((d) => d.documentId));
  const loose = docsInScope(visible, KB_UNCATEGORIZED, tree).length;

  const tabNode = tab && tab !== KB_UNCATEGORIZED ? tree.byId.get(tab) : undefined;
  const activeTab = tab === KB_UNCATEGORIZED ? (loose > 0 ? tab : null) : tabNode && tabNode.depth === 1 ? tab : null;
  const inTab = tabNode && activeTab ? subtreeIds(tabNode) : null;
  const subNodes = inTab ? tree.order.filter((n) => n !== tabNode && inTab.has(n.category.id)) : [];
  const activeSub = sub && subNodes.some((n) => n.category.id === sub) ? sub : null;
  const scoped = docsInScope(visible, activeSub ?? activeTab, tree);
  const cards = sort === "manual" ? sortDocs(scoped, "manual", libraryOrder(tree)) : sortDocs(scoped, sort);

  const tabs: Array<{ key: string | null; label: string; count: number; node?: KbCategoryNode }> = [
    { key: null, label: "All", count: visible.length },
    ...tree.roots.map((node) => ({ key: node.category.id, label: node.category.name, count: countIn(node, ids), node })),
    ...(loose > 0 ? [{ key: KB_UNCATEGORIZED, label: "Not in a category", count: loose }] : [])
  ];
  const activeIndex = Math.max(0, tabs.findIndex((t) => t.key === activeTab));

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    onScope(tabs[next]?.key ?? null, null);
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={tabsRef}
        role="tablist"
        aria-label="Categories"
        // The baseline is an inset shadow, not a border, so the selected underline can sit on it without a negative margin (which made the row scroll vertically).
        className="flex min-w-0 gap-1 overflow-x-auto [box-shadow:inset_0_-1px_0_oklch(var(--border))] [scrollbar-width:none]"
      >
        {tabs.map((t, i) => {
          const selected = i === activeIndex;
          const color = t.node ? kbEffectiveCategoryColor(t.node.category) : null;
          return (
            <button
              key={t.key ?? "all"}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onScope(t.key, null)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                selected ? "font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              )}
              // The selected tab is underlined in its category color (primary for All).
              style={selected ? { borderBottomColor: color ? kbColorDot(color).backgroundColor : "oklch(var(--primary))" } : undefined}
            >
              {color ? <ColorDot color={color} /> : null}
              {t.label}
              <span className="tabular-nums text-xs text-muted-foreground">
                {t.count}
                <span className="sr-only"> {t.count === 1 ? "source" : "sources"}</span>
              </span>
            </button>
          );
        })}
      </div>

      {subNodes.length > 0 && tabNode ? (
        <div role="group" aria-label={`Subcategories of ${tabNode.category.name}`} className="flex flex-wrap gap-1.5">
          <SubChip pressed={activeSub === null} onClick={() => onScope(activeTab, null)} label={`All in ${tabNode.category.name}`} />
          {subNodes.map((node) => (
            <SubChip
              key={node.category.id}
              pressed={activeSub === node.category.id}
              onClick={() => onScope(activeTab, node.category.id)}
              label={node.path.slice(1).join(" / ")}
              count={countIn(node, ids)}
              color={kbEffectiveCategoryColor(node.category)}
            />
          ))}
        </div>
      ) : null}

      <div id={panelId} role="tabpanel" aria-label={tabs[activeIndex]?.label ?? "All"}>
        {cards.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
            No sources here match the current search or filters.
          </p>
        ) : (
          <ul aria-label="Sources" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((doc) => (
              <KbDocCard key={doc.documentId} doc={doc} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SubChip({
  pressed,
  onClick,
  label,
  count,
  color
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  color?: Parameters<typeof ColorDot>[0]["color"];
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "btn-base gap-1.5 border px-3 py-1 text-xs",
        pressed
          ? "border-primary/40 bg-primary/10 font-medium text-primary"
          : "border-border bg-secondary text-secondary-foreground hover:border-foreground/20"
      )}
    >
      {color ? <ColorDot color={color} /> : null}
      {label}
      {count !== undefined ? <span className="tabular-nums text-muted-foreground">{count}</span> : null}
    </button>
  );
}
