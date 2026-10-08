import { useId, type ReactNode, type RefObject } from "react";
import {
  Bookmark,
  Check,
  FolderCog,
  FolderTree,
  List,
  Palette,
  RotateCcw,
  Rows3,
  Search,
  Sparkles,
  StickyNote,
  Tags,
  X
} from "lucide-react";
import {
  KB_SORT_LABELS,
  type KbFilters,
  type KbSort,
  type KbView
} from "@/lib/kbLibrary";
import { kbColorLabel } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbLibraryColor, KbTag } from "@/types/api";
import { KbMenu } from "./KbMenu";
import { ColorDot } from "./KbShared";

const VIEWS: Array<{ id: KbView; label: string; icon: typeof FolderTree; hint: string }> = [
  { id: "folders", label: "Folders", icon: FolderTree, hint: "Nested folders in your manager's order" },
  { id: "categories", label: "Categories", icon: Rows3, hint: "One section per category" },
  { id: "list", label: "List", icon: List, hint: "Everything in one list" }
];

const SORTS: KbSort[] = ["manual", "newest", "updated", "views", "cited", "title"];

function FilterChip({
  pressed,
  onClick,
  icon: Icon,
  children
}: {
  pressed: boolean;
  onClick: () => void;
  icon: typeof Sparkles;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "btn-base gap-1.5 border px-3 py-1 text-xs",
        pressed
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-border bg-secondary text-secondary-foreground hover:border-foreground/20"
      )}
    >
      {pressed ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Icon className="h-3.5 w-3.5" aria-hidden />}
      {children}
    </button>
  );
}

export function KbToolbar({
  query,
  onQuery,
  view,
  onView,
  sort,
  onSort,
  filters,
  onFilters,
  tags,
  colors,
  shown,
  total,
  active,
  onReset,
  canOrganize,
  onOrganize,
  searchRef
}: {
  query: string;
  onQuery: (query: string) => void;
  view: KbView;
  onView: (view: KbView) => void;
  sort: KbSort;
  onSort: (sort: KbSort) => void;
  filters: KbFilters;
  onFilters: (filters: KbFilters) => void;
  tags: KbTag[];
  /** Colors the user has put on at least one source (plus any still selected). */
  colors: KbLibraryColor[];
  shown: number;
  total: number;
  active: boolean;
  onReset: () => void;
  canOrganize: boolean;
  onOrganize: () => void;
  searchRef: RefObject<HTMLInputElement>;
}): JSX.Element {
  const sortId = useId();
  const selectedTags = tags.filter((t) => filters.tagIds.includes(t.id));

  function toggleTag(tagId: string): void {
    const tagIds = filters.tagIds.includes(tagId)
      ? filters.tagIds.filter((id) => id !== tagId)
      : [...filters.tagIds, tagId];
    onFilters({ ...filters, tagIds });
  }

  function toggleColor(color: KbLibraryColor): void {
    const next = filters.colors.includes(color)
      ? filters.colors.filter((c) => c !== color)
      : [...filters.colors, color];
    onFilters({ ...filters, colors: next });
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <span className="sr-only">Search sources</span>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.preventDefault();
              onQuery("");
            }
          }}
          placeholder="Search titles, notes, tags and categories"
          className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-10 text-sm shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        {!query ? (
          <span className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 sm:block" aria-hidden>
            <kbd className="kbd">/</kbd>
          </span>
        ) : null}
      </label>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div role="group" aria-label="View" className="inline-flex rounded-full border border-border bg-secondary p-0.5">
          {VIEWS.map(({ id, label, icon: Icon, hint }) => (
            <button
              key={id}
              type="button"
              aria-pressed={view === id}
              title={hint}
              onClick={() => onView(id)}
              className={cn(
                "btn-base gap-1.5 px-3 py-1 text-xs",
                view === id
                  ? "bg-card text-foreground shadow-card"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={sortId} className="text-xs text-muted-foreground">
            Sort
          </label>
          <select
            id={sortId}
            value={sort}
            onChange={(e) => onSort(e.target.value as KbSort)}
            className="select-quiet rounded-full border border-border bg-secondary py-1 pl-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {SORTS.map((s) => (
              <option key={s} value={s}>
                {KB_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        {canOrganize ? (
          <button
            type="button"
            onClick={onOrganize}
            className="btn-whisper ml-auto gap-1.5 px-3 py-1 text-xs"
            title="Arrange categories, tags and team pins for everyone"
          >
            <FolderCog className="h-3.5 w-3.5" aria-hidden />
            Organize
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
        <FilterChip
          pressed={filters.newOnly}
          icon={Sparkles}
          onClick={() => onFilters({ ...filters, newOnly: !filters.newOnly })}
        >
          New
        </FilterChip>
        <FilterChip
          pressed={filters.myPins}
          icon={Bookmark}
          onClick={() => onFilters({ ...filters, myPins: !filters.myPins })}
        >
          My pins
        </FilterChip>
        <FilterChip
          pressed={filters.hasNote}
          icon={StickyNote}
          onClick={() => onFilters({ ...filters, hasNote: !filters.hasNote })}
        >
          Has my note
        </FilterChip>
        {tags.length > 0 ? (
          <KbMenu
            label="Filter by tags"
            title="Filter by tags"
            buttonClassName={cn(
              "btn-base gap-1.5 border px-3 py-1 text-xs",
              selectedTags.length > 0
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-secondary text-secondary-foreground hover:border-foreground/20"
            )}
            items={tags.map((tag) => ({
              label: tag.name,
              checked: filters.tagIds.includes(tag.id),
              onSelect: () => toggleTag(tag.id)
            }))}
          >
            <Tags className="h-3.5 w-3.5" aria-hidden />
            Tags{selectedTags.length > 0 ? ` (${selectedTags.length})` : ""}
          </KbMenu>
        ) : null}
        {selectedTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => toggleTag(tag.id)}
            aria-label={`Remove tag filter ${tag.name}`}
            className="btn-base gap-1.5 border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:border-foreground/20"
          >
            <ColorDot color={tag.color} />
            {tag.name}
            <X className="h-3 w-3 text-muted-foreground" aria-hidden />
          </button>
        ))}
        {colors.length > 0 ? (
          <KbMenu
            label="Filter by my color"
            title="Filter by the colors you put on sources"
            buttonClassName={cn(
              "btn-base gap-1.5 border px-3 py-1 text-xs",
              filters.colors.length > 0
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border bg-secondary text-secondary-foreground hover:border-foreground/20"
            )}
            items={colors.map((color) => ({
              label: kbColorLabel(color),
              swatch: color,
              checked: filters.colors.includes(color),
              onSelect: () => toggleColor(color)
            }))}
          >
            <Palette className="h-3.5 w-3.5" aria-hidden />
            Color{filters.colors.length > 0 ? ` (${filters.colors.length})` : ""}
          </KbMenu>
        ) : null}
        {filters.colors.map((color) => (
          <button
            key={color}
            type="button"
            onClick={() => toggleColor(color)}
            aria-label={`Remove color filter ${kbColorLabel(color)}`}
            className="btn-base gap-1.5 border border-border bg-card px-2.5 py-1 text-xs text-foreground hover:border-foreground/20"
          >
            <ColorDot color={color} />
            {kbColorLabel(color)}
            <X className="h-3 w-3 text-muted-foreground" aria-hidden />
          </button>
        ))}
        {active ? (
          <button type="button" onClick={onReset} className="btn-icon gap-1 px-2 text-xs">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            Reset
          </button>
        ) : null}
        <p className="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {active ? `${shown} of ${total} sources` : `${total} ${total === 1 ? "source" : "sources"}`}
        </p>
      </div>
    </div>
  );
}
