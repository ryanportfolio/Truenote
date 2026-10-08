import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { personLabel, plural, roleLabel } from "@/lib/sourceUsage";
import type { SourceUsagePerson } from "@/types/api";

interface PersonPickerProps {
  /** Every program member, including people with no questions in the window. */
  people: readonly SourceUsagePerson[];
  selectedId: string | null;
  /** Shown on the trigger when the selected person is not in `people` (no questions this window). */
  selectedLabel: string | null;
  onSelect: (userId: string | null) => void;
}

/**
 * Searchable person filter over every program member (zero-question people
 * included, so a new hire can be checked). A disclosure button opens a small panel with a
 * search box and option buttons; arrow keys move between options, Enter in
 * the search box picks the first match, Escape closes and returns focus.
 */
export function PersonPicker({
  people,
  selectedId,
  selectedLabel,
  onSelect
}: PersonPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const panelId = useId();
  const searchId = useId();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...people].sort((a, b) =>
      personLabel(a).localeCompare(personLabel(b), undefined, { sensitivity: "base" })
    );
    if (!needle) return sorted;
    return sorted.filter((person) => person.name.toLowerCase().includes(needle));
  }, [people, query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(): void {
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function choose(userId: string | null): void {
    onSelect(userId);
    close();
  }

  function options(): HTMLButtonElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  }

  function onPanelKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = options();
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) {
      items[event.key === "ArrowDown" ? 0 : items.length - 1]?.focus();
      return;
    }
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    if (next < 0) {
      inputRef.current?.focus();
      return;
    }
    items[Math.min(next, items.length - 1)]?.focus();
  }

  const selected = people.find((person) => person.userId === selectedId) ?? null;
  const triggerText = selectedId
    ? selected
      ? personLabel(selected)
      : selectedLabel ?? "Selected person"
    : "Everyone";

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
        className="btn-whisper inline-flex max-w-[16rem] items-center gap-2 px-3 py-1.5 text-sm"
      >
        <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-muted-foreground">Person:</span>
        <span className="truncate font-medium" title={triggerText}>{triggerText}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </button>

      {open ? (
        <div
          id={panelId}
          onKeyDown={onPanelKeyDown}
          className="absolute right-0 z-30 mt-2 w-[min(20rem,85vw)] rounded-lg border border-border bg-card p-2 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100"
        >
          <label htmlFor={searchId} className="sr-only">
            Search people
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              ref={inputRef}
              id={searchId}
              type="search"
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const first = matches[0];
                  if (first) choose(first.userId);
                }
              }}
              placeholder="Search by name"
              className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
            />
          </div>
          <ul ref={listRef} className="mt-2 max-h-72 overflow-y-auto" aria-label="People">
            {query.trim() === "" ? (
              <li>
                <PersonOption
                  label="Everyone"
                  detail="All people in this program"
                  selected={selectedId === null}
                  onClick={() => choose(null)}
                />
              </li>
            ) : null}
            {matches.map((person) => (
              <li key={person.userId}>
                <PersonOption
                  label={personLabel(person)}
                  detail={roleLabel(person.role)}
                  count={
                    person.questionCount > 0
                      ? plural(person.questionCount, "question", "questions")
                      : "No questions yet"
                  }
                  selected={selectedId === person.userId}
                  onClick={() => choose(person.userId)}
                />
              </li>
            ))}
            {matches.length === 0 ? (
              <li className="px-2 py-2 text-sm text-muted-foreground">
                {people.length === 0
                  ? "No people in this program yet."
                  : "No one matches that search."}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function PersonOption({
  label,
  detail,
  count,
  selected,
  onClick
}: {
  label: string;
  detail: string | null;
  count?: string;
  selected: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors duration-100 ease-out hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-primary/10"
      )}
    >
      <Check
        className={cn("mt-0.5 h-4 w-4 shrink-0 text-primary", !selected && "invisible")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", selected && "font-medium text-primary")}>
          {label}
        </span>
        {detail ? (
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {count ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </button>
  );
}
