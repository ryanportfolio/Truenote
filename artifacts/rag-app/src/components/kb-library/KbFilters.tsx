import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { KB_SORT_LABELS, type KbFilters, type KbSort } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbLibraryColor, KbTag } from "@/types/api";
import { KbLabels } from "./KbLabels";
import { ColorDot } from "./KbShared";

const SORTS: KbSort[] = ["manual", "newest", "updated", "views", "cited", "title"];

function Check({
  checked,
  onChange,
  children,
  hint
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: string;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-1 py-1.5 text-sm hover:bg-muted/60">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-foreground">{children}</span>
        {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      </span>
    </label>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  const id = useId();
  return (
    <div className="border-t border-border pt-3 first:border-t-0 first:pt-0">
      <fieldset aria-labelledby={id}>
        <legend id={id} className="mb-1 text-sm font-medium text-foreground">
          {title}
        </legend>
        {children}
      </fieldset>
    </div>
  );
}

/** How many separate filters are on (Sort is not a filter). */
export function activeFilterCount(filters: KbFilters): number {
  return (
    Number(filters.newOnly) +
    Number(filters.updatedOnly) +
    Number(filters.hasNote) +
    filters.tagIds.length +
    filters.colors.length
  );
}

/**
 * One "Filters" button. Its panel holds New, Updated, Has my note, Labels
 * (with their names; only below 1280px, where the My labels card is not on
 * screen), Tags and Sort. Escape or a click outside closes it and focus
 * goes back to the button.
 */
export function KbFiltersButton({
  filters,
  onFilters,
  sort,
  onSort,
  tags,
  showLabels
}: {
  filters: KbFilters;
  onFilters: (filters: KbFilters) => void;
  sort: KbSort;
  onSort: (sort: KbSort) => void;
  tags: KbTag[];
  /** Labels live here when the My labels card is not beside the list. */
  showLabels: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const sortName = useId();
  const count = activeFilterCount(filters);

  function close(returnFocus: boolean): void {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      // A label rename dialog or menu opened from inside stays part of the panel.
      if (target instanceof Element && target.closest("[role=menu], [role=dialog]") && !panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close(true);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function toggleIn<T>(list: T[], value: T): T[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  return (
    // Phones: the panel spans the search row (the nearest positioned parent) instead of hanging off the button.
    <div className="shrink-0 sm:relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        data-kb-filters-button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "btn-whisper h-12 gap-2 px-4 text-base",
          (open || count > 0) && "border-primary/40 bg-primary/5 text-primary hover:text-primary"
        )}
      >
        <SlidersHorizontal className="h-5 w-5" aria-hidden />
        <span className="max-sm:sr-only">Filters</span>
        {count > 0 ? (
          <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">
            {count}
            <span className="sr-only"> on</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Filters"
          data-kb-filters-panel
          className="absolute right-0 top-full z-40 mt-2 flex max-h-[min(40rem,75dvh)] flex-col max-sm:left-0 sm:w-[22rem] gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:[animation-duration:100ms]"
        >
          <Group title="Show only">
            <Check
              checked={filters.newOnly}
              onChange={(v) => onFilters({ ...filters, newOnly: v })}
              hint="Added or changed in the last 2 weeks"
            >
              New
            </Check>
            <Check
              checked={filters.updatedOnly}
              onChange={(v) => onFilters({ ...filters, updatedOnly: v })}
              hint="Older sources that changed in the last 2 weeks"
            >
              Updated
            </Check>
            <Check checked={filters.hasNote} onChange={(v) => onFilters({ ...filters, hasNote: v })}>
              Has my note
            </Check>
          </Group>
          {showLabels ? (
            <div className="border-t border-border pt-3">
              <KbLabels
                variant="popover"
                selected={filters.colors}
                onToggle={(color: KbLibraryColor) => onFilters({ ...filters, colors: toggleIn(filters.colors, color) })}
              />
            </div>
          ) : null}
          {tags.length > 0 ? (
            <Group title="Tags">
              {tags.map((tag) => (
                <Check
                  key={tag.id}
                  checked={filters.tagIds.includes(tag.id)}
                  onChange={() => onFilters({ ...filters, tagIds: toggleIn(filters.tagIds, tag.id) })}
                >
                  <ColorDot color={tag.color} />
                  {tag.name}
                </Check>
              ))}
            </Group>
          ) : null}
          <Group title="Sort">
            {SORTS.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1.5 text-sm hover:bg-muted/60">
                <input
                  type="radio"
                  name={sortName}
                  checked={sort === s}
                  onChange={() => onSort(s)}
                  className="h-4 w-4 shrink-0 accent-primary"
                />
                {KB_SORT_LABELS[s]}
              </label>
            ))}
          </Group>
          <div className="flex justify-end border-t border-border pt-3">
            <button type="button" onClick={() => close(true)} className="btn-whisper px-4 py-1.5 text-sm">
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The active filters in one sentence, with Clear. */
export function KbFilterSentence({ sentence, onClear }: { sentence: string; onClear: () => void }): JSX.Element {
  return (
    <div data-kb-filter-sentence className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <p className="min-w-0 text-sm text-foreground" role="status" aria-live="polite">
        {sentence}
      </p>
      <button
        type="button"
        onClick={onClear}
        className="cursor-pointer rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        Clear
      </button>
    </div>
  );
}
