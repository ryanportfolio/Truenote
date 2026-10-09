import type { ReactNode } from "react";
import { Search, Table2, UserMinus, UsersRound } from "lucide-react";
import { KbMenu, type KbMenuEntry } from "@/components/kb-library/KbMenu";
import { cn } from "@/lib/utils";
import type { TeamsView } from "@/lib/teamsView";
import type { TeamsSupervisor } from "@/types/api";

const VIEW_OPTIONS: readonly { view: TeamsView; label: string; Icon: typeof UsersRound }[] = [
  { view: "roster", label: "Roster", Icon: UsersRound },
  { view: "table", label: "Table", Icon: Table2 }
];

/** Roster or table; the same segmented recipe as the source usage view switch. */
export function TeamsViewSwitch({
  view,
  onChange
}: {
  view: TeamsView;
  onChange: (view: TeamsView) => void;
}): JSX.Element {
  return (
    <div role="group" aria-label="Show teams as" className="flex shrink-0 overflow-hidden rounded-lg border border-border">
      {VIEW_OPTIONS.map(({ view: option, label, Icon }) => (
        <button
          key={option}
          type="button"
          aria-pressed={view === option}
          onClick={() => onChange(option)}
          className={cn(
            "relative inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm font-medium transition-colors duration-100 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            view === option
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground"
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}

/** Filter pill with a count; selected = tint + border + aria-pressed (the Gaps filter recipe). */
export function FilterPill({
  pressed,
  onClick,
  label,
  count
}: {
  pressed: boolean;
  onClick: () => void;
  label: string;
  count: number;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        pressed
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-input text-muted-foreground transition-colors duration-100 ease-out hover:bg-secondary hover:text-foreground"
      )}
    >
      {label}
      <span className="tabular-nums">{count}</span>
    </button>
  );
}

/** Search box with an inset icon (the library's "Find a source" field). */
export function SearchField({
  id,
  value,
  onChange,
  className
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("relative", className)}>
      <label htmlFor={id} className="sr-only">
        Search people by name or email
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        id={id}
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search people"
        autoComplete="off"
        className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
    </div>
  );
}

/** Which team a CSR is on: the supervisor's first name, or an amber "Unassigned". */
export function SupervisorChip({ name }: { name: string | null }): JSX.Element {
  return name === null ? (
    <span className="inline-flex shrink-0 items-center rounded-full bg-warning/20 px-2.5 py-0.5 text-xs font-medium text-warning-foreground">
      Unassigned
    </span>
  ) : (
    <span className="inline-flex max-w-[8rem] shrink-0 items-center truncate rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
      {name}
    </span>
  );
}

/** The destinations for a move: each supervisor's team, then Unassigned. */
export function moveMenuEntries(
  supervisors: TeamsSupervisor[],
  onPick: (supervisorId: string | null) => void
): KbMenuEntry[] {
  return [
    ...supervisors.map((s) => ({ label: s.name, icon: UsersRound, onSelect: () => onPick(s.id) })),
    "separator" as const,
    { label: "Unassigned", icon: UserMinus, onSelect: () => onPick(null) }
  ];
}

/** "Move to…" / "Assign supervisor": the selection's one primary action. */
export function MoveMenu({
  label,
  supervisors,
  onPick
}: {
  label: string;
  supervisors: TeamsSupervisor[];
  onPick: (supervisorId: string | null) => void;
}): JSX.Element {
  return (
    <KbMenu
      label={label}
      title={label}
      items={moveMenuEntries(supervisors, onPick)}
      buttonClassName="btn-primary shrink-0 px-4 py-1.5"
    >
      {label}
    </KbMenu>
  );
}

/**
 * The selection bar: "N selected", a quiet Clear, and the move action.
 * Sticky at the bottom of the scrollport (the shortcuts dock recipe), so
 * it stays reachable in a long list.
 */
export function SelectionBar({
  count,
  onClear,
  children,
  label,
  className
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        "sticky bottom-3 z-30 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-card px-4 py-2 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:[animation-duration:120ms]",
        className
      )}
    >
      <span className="text-sm font-medium tabular-nums">{count} selected</span>
      <button type="button" onClick={onClear} className="btn-whisper px-3 py-1 text-xs">
        Clear
      </button>
      <span className="ml-auto">{children}</span>
    </div>
  );
}

/** Dismissable quiet alert for a failed move. */
export function ActionAlert({ message, onDismiss }: { message: string; onDismiss: () => void }): JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <p className="min-w-0 flex-1">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 cursor-pointer rounded-sm text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Dismiss
      </button>
    </div>
  );
}
