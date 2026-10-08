import type { ReactNode } from "react";
import { KB_UNCATEGORIZED, subtreeDocumentIds } from "@/lib/kbLibrary";
import { kbEffectiveCategoryColor } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { ColorDot } from "./KbShared";

function RailItem({
  label,
  count,
  selected,
  depth = 1,
  leading,
  onSelect
}: {
  label: string;
  count: number;
  selected: boolean;
  depth?: number;
  leading?: ReactNode;
  onSelect: () => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        style={{ paddingLeft: `${0.5 + (depth - 1) * 0.875}rem` }}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "bg-primary/10 font-medium text-primary" : "text-foreground hover:bg-muted"
        )}
      >
        {leading}
        <span className="min-w-0 flex-1 truncate" title={label}>
          {label}
        </span>
        <span className={cn("shrink-0 tabular-nums text-xs", selected ? "text-primary" : "text-muted-foreground")}>
          {count}
          <span className="sr-only"> {count === 1 ? "source" : "sources"}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * Wide screens, Folders view: every category in the manager's order beside
 * the list, with the color the user sees (their own over the team's) and how
 * many of the listed sources each holds. Picking one scopes the list to it;
 * "Not in a category" sits apart at the end.
 */
export function KbCategoryRail({
  visible,
  scope,
  onScope
}: {
  /** Sources that pass the current search and filters; counts match the list. */
  visible: KbDocumentListItem[];
  scope: string | null;
  onScope: (scope: string | null) => void;
}): JSX.Element {
  const { lookup } = useKbLibraryContext();
  const ids = new Set(visible.map((d) => d.documentId));
  const loose = visible.filter((d) => !d.categoryIds.some((id) => lookup.tree.byId.has(id))).length;
  return (
    <nav
      aria-label="Categories"
      data-kb-rail
      className="sticky top-4 max-h-[calc(100dvh-7rem)] overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-card"
    >
      <h2 className="px-2 pb-1 pt-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Categories</h2>
      <ul className="flex flex-col gap-px">
        <RailItem label="All sources" count={visible.length} selected={scope === null} onSelect={() => onScope(null)} />
        {lookup.tree.order.map((node) => {
          let count = 0;
          subtreeDocumentIds(node).forEach((id) => {
            if (ids.has(id)) count += 1;
          });
          return (
            <RailItem
              key={node.category.id}
              label={node.category.name}
              count={count}
              depth={node.depth}
              selected={scope === node.category.id}
              leading={<ColorDot color={kbEffectiveCategoryColor(node.category)} />}
              onSelect={() => onScope(node.category.id)}
            />
          );
        })}
      </ul>
      <ul className="mt-1 border-t border-border pt-1">
        <RailItem
          label="Not in a category"
          count={loose}
          selected={scope === KB_UNCATEGORIZED}
          leading={
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-dashed border-muted-foreground" aria-hidden />
          }
          onSelect={() => onScope(KB_UNCATEGORIZED)}
        />
      </ul>
    </nav>
  );
}
