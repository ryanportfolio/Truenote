import { forwardRef, useEffect, useId, useRef } from "react";
import { Link } from "wouter";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Clock,
  GripVertical,
  Megaphone,
  NotebookPen,
  X
} from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import {
  KB_DRAG_MOTION,
  KB_MAX_TEAM_PINS,
  KB_NUMBERED_PINS,
  docCategoryPaths,
  moveItem
} from "@/lib/kbLibrary";
import { kbColorDot } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { pathsLabel } from "./KbDocRow";
import { ColorDot, NewBadge, PinToggle, SourceColorLabel } from "./KbShared";
import { useReducedMotion } from "./useReducedMotion";

function usePathLabel(doc: KbDocumentListItem): string {
  const { lookup } = useKbLibraryContext();
  return pathsLabel(docCategoryPaths(doc, lookup.tree));
}

/** "Press 1 to 6 to open a pin." */
export function PinKeyHint({ count, className }: { count: number; className?: string }): JSX.Element | null {
  const last = Math.min(count, KB_NUMBERED_PINS);
  if (last < 1) return null;
  return (
    <p data-kb-pin-hint className={cn("text-xs text-muted-foreground", className)}>
      Press <kbd className="kbd">1</kbd>
      {last > 1 ? (
        <>
          {" "}to <kbd className="kbd">{last}</kbd> to open a pin.
        </>
      ) : (
        " to open your pin."
      )}
    </p>
  );
}

/**
 * One of my pins: number key, title (up to two lines), category path, and the
 * personal color as the left edge. The whole tile opens the source.
 */
function MyPinTile({ doc, index }: { doc: KbDocumentListItem; index: number }): JSX.Element {
  const { actions } = useKbLibraryContext();
  const path = usePathLabel(doc);
  const number = index < KB_NUMBERED_PINS ? index + 1 : null;
  return (
    <li
      data-kb-pin={number ?? undefined}
      className="relative flex min-w-0 items-start gap-2 rounded-md border border-border bg-card py-1.5 pl-2.5 pr-1 shadow-card transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40"
    >
      {doc.myColor ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-1 rounded-l-md" style={kbColorDot(doc.myColor)} />
      ) : null}
      {number ? (
        <span
          aria-hidden
          className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground"
        >
          {number}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <Link
          href={`/kb/${doc.documentId}`}
          aria-keyshortcuts={number ? String(number) : undefined}
          className="line-clamp-2 break-words rounded-sm text-sm font-medium leading-snug text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          title={doc.title}
        >
          <SourceColorLabel color={doc.myColor} />
          {number ? <span className="sr-only">Pin {number}: </span> : null}
          <span data-kb-title>{doc.title}</span>
        </Link>
        {path || doc.isNew || doc.note ? (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {path ? (
              <span data-kb-path className="min-w-0 truncate" title={path}>
                <span className="sr-only">In </span>
                {path}
              </span>
            ) : null}
            {doc.isNew ? <NewBadge /> : null}
            {doc.note ? (
              <span className="inline-flex shrink-0 items-center" title="Has my note">
                <NotebookPen className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">Has my note.</span>
              </span>
            ) : null}
          </p>
        ) : null}
      </div>
      <PinToggle
        doc={doc}
        className="relative z-10 -my-0.5 h-7 w-7 shrink-0"
        onToggle={() => actions.togglePin(doc.documentId)}
      />
    </li>
  );
}

/** A team pin: compact link with its category path, in the manager's order. */
function TeamPinLink({ doc }: { doc: KbDocumentListItem }): JSX.Element {
  const path = usePathLabel(doc);
  return (
    <li className="min-w-0">
      <Link
        href={`/kb/${doc.documentId}`}
        className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <SourceColorLabel color={doc.myColor} />
          <span data-kb-title className="break-words">{doc.title}</span>
        </span>
        {path ? (
          <span data-kb-path className="block text-xs text-muted-foreground">
            <span className="sr-only">In </span>
            {path}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/**
 * The special place above the library: manager-chosen team pins, the user's
 * own numbered pins (newest pin first), then the sources they opened last.
 * Hidden while searching or filtering so results sit at the top.
 */
export const KbPinStrips = forwardRef<
  HTMLElement,
  {
    team: KbDocumentListItem[];
    mine: KbDocumentListItem[];
    recent: KbDocumentListItem[];
    /** My pins and Recently opened folded to their heading line (saved per user). */
    collapsed: boolean;
    onToggleCollapsed: () => void;
  }
>(function KbPinStrips({ team, mine, recent, collapsed, onToggleCollapsed }, myPinsRef): JSX.Element {
  const panelId = useId();
  const toggle =
    mine.length > 0 || recent.length > 0 ? (
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-controls={panelId}
        className="btn-icon -my-1 gap-1 px-2 text-xs"
        title={collapsed ? "Show my pins and recently opened" : "Fold my pins and recently opened to one line"}
      >
        {collapsed ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronUp className="h-3.5 w-3.5" aria-hidden />}
        {collapsed ? "Show" : "Hide"}
      </button>
    ) : null;
  return (
    <div className="flex flex-col gap-2.5">
      {team.length > 0 ? (
        <section
          aria-labelledby="kb-team-pins"
          className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2"
        >
          <h2 id="kb-team-pins" className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Megaphone className="h-3.5 w-3.5 text-primary" aria-hidden />
            <span className="font-medium uppercase tracking-wide text-primary">Team pins</span>
            <span>from your manager</span>
          </h2>
          <ul className="mt-1 flex min-w-0 flex-wrap gap-x-5 gap-y-1.5">
            {team.map((doc) => (
              <TeamPinLink key={doc.documentId} doc={doc} />
            ))}
          </ul>
        </section>
      ) : null}
      {mine.length > 0 ? (
        <section
          ref={myPinsRef}
          aria-labelledby="kb-my-pins"
          className="rounded-lg border border-border bg-secondary px-3 py-2"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2
              id="kb-my-pins"
              className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              <Bookmark className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
              My pins
              {collapsed ? (
                <span className="rounded-full bg-muted px-1.5 font-normal normal-case tracking-normal tabular-nums">
                  {mine.length}
                </span>
              ) : null}
            </h2>
            <div className="flex items-center gap-2">
              <PinKeyHint count={mine.length} />
              {toggle}
            </div>
          </div>
          <ul
            id={panelId}
            hidden={collapsed}
            // The class, not only the attribute: "grid" would override [hidden].
            className={cn("mt-1.5 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3", collapsed && "hidden")}
          >
            {mine.map((doc, i) => (
              <MyPinTile key={doc.documentId} doc={doc} index={i} />
            ))}
          </ul>
        </section>
      ) : (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Bookmark className="h-3.5 w-3.5" aria-hidden />
          Pin sources you use often with the bookmark button. They stay here, at the top, with a number key each.
        </p>
      )}
      {recent.length > 0 && !(collapsed && mine.length > 0) ? (
        <section
          data-kb-recent
          aria-labelledby="kb-recent"
          className="px-1"
        >
          <h2
            id="kb-recent"
            className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            <Clock className="h-3.5 w-3.5" aria-hidden />
            Recently opened
          </h2>
          <ol className="mt-1 flex min-w-0 flex-wrap gap-1.5">
            {recent.map((doc) => (
              <li key={doc.documentId} className="min-w-0 max-w-full">
                <Link
                  href={`/kb/${doc.documentId}`}
                  title={doc.title}
                  className="btn-base max-w-full gap-1.5 rounded-lg border border-border bg-card px-3 py-1 text-left text-xs text-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:rounded-full"
                >
                  <SourceColorLabel color={doc.myColor} />
                  {doc.myColor ? <ColorDot color={doc.myColor} /> : null}
                  <span data-kb-title className="min-w-0 break-words font-medium sm:max-w-[16rem] sm:truncate">
                    {doc.title}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                    <span className="sr-only">, opened </span>
                    <RelativeTime iso={doc.lastViewedByMeAt as string} />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
});

/**
 * My pins, docked to the bottom of the viewport once the strip above has
 * scrolled away (or is hidden by a search). Sticky inside the page column,
 * so at the end of the page it sits after the last row instead of over it.
 */
export function KbPinsDock({ mine, shown }: { mine: KbDocumentListItem[]; shown: boolean }): JSX.Element {
  // Hidden, not unmounted: the page keeps the dock's space at its end, so the
  // dock can never cover the last row. inert keeps the hidden links out of Tab.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.toggleAttribute("inert", !shown);
  }, [shown]);
  return (
    <nav
      data-kb-dock={shown ? "shown" : "hidden"}
      aria-label="My pins"
      ref={ref}
      aria-hidden={!shown || undefined}
      className={cn(
        "sticky bottom-3 z-30 flex min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 shadow-panel motion-safe:transition-[opacity,transform] motion-safe:duration-240 motion-safe:ease-out-quart",
        shown ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0"
      )}
    >
      <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Bookmark className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
        <span className="hidden sm:inline">My pins</span>
        <span className="rounded-full bg-muted px-1.5 tabular-nums normal-case tracking-normal">{mine.length}</span>
      </span>
      <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible">
        {mine.map((doc, i) => (
          <li key={doc.documentId} className="shrink-0">
            <Link
              href={`/kb/${doc.documentId}`}
              title={doc.title}
              aria-keyshortcuts={i < KB_NUMBERED_PINS ? String(i + 1) : undefined}
              className="btn-base gap-1.5 border border-border bg-secondary px-2.5 py-1 text-xs text-foreground hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {i < KB_NUMBERED_PINS ? (
                <span aria-hidden className="tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
              ) : null}
              {doc.myColor ? <ColorDot color={doc.myColor} /> : null}
              <span className="max-w-[12rem] truncate">{doc.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SortablePin({
  doc,
  index,
  count
}: {
  doc: KbDocumentListItem;
  index: number;
  count: number;
}): JSX.Element {
  const { actions } = useKbLibraryContext();
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: doc.documentId, transition: reducedMotion ? null : KB_DRAG_MOTION });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex min-w-0 items-center gap-2", isDragging && "relative z-30")}
    >
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-primary/25 bg-card text-xs font-medium tabular-nums text-primary"
      >
        {index + 1}
      </span>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-md border border-border bg-card py-0.5 pl-1 pr-1 shadow-card",
          isDragging && "shadow-panel"
        )}
      >
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${doc.title} to reorder team pins`}
          className="btn-icon h-8 w-8 cursor-grab touch-none active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={doc.title}>
          <span className="sr-only">Position {index + 1}: </span>
          {doc.title}
        </span>
        <button
          type="button"
          onClick={() => actions.moveTeamPinBy(doc.documentId, -1)}
          disabled={index === 0}
          aria-label={`Move ${doc.title} earlier`}
          title="Move earlier"
          className="btn-icon h-8 w-8"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => actions.moveTeamPinBy(doc.documentId, 1)}
          disabled={index === count - 1}
          aria-label={`Move ${doc.title} later`}
          title="Move later"
          className="btn-icon h-8 w-8"
        >
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => actions.removeTeamPin(doc.documentId)}
          aria-label={`Remove team pin from ${doc.title}`}
          title="Remove team pin"
          className="btn-icon h-8 w-8"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </li>
  );
}

/** Organize mode: team pins as a numbered, reorderable lane with its capacity. */
export function KbTeamPinsEditor({ team }: { team: KbDocumentListItem[] }): JSX.Element {
  const { actions } = useKbLibraryContext();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const ids = team.map((d) => d.documentId);
  const titleOf = (id: string | number) => team.find((d) => d.documentId === id)?.title ?? "Source";

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    void actions.setTeamPins(moveItem(ids, from, to), `Moved ${titleOf(active.id)} to position ${to + 1}.`);
  }

  return (
    <section aria-labelledby="kb-team-pins-edit" className="rounded-lg border border-primary/20 bg-primary/5 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 px-1">
        <h2
          id="kb-team-pins-edit"
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary"
        >
          <Megaphone className="h-3.5 w-3.5" aria-hidden />
          Team pins
        </h2>
        <p data-kb-team-capacity className="text-xs tabular-nums text-muted-foreground">
          {team.length} of {KB_MAX_TEAM_PINS}
        </p>
      </div>
      <p className="mt-0.5 px-1 text-xs text-muted-foreground">
        Drag to reorder. Everyone in this program sees these first, in this order.
      </p>
      {team.length === 0 ? null : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{
            screenReaderInstructions: {
              draggable:
                "To reorder, press space or enter, use the arrow keys to move, then press space or enter to drop. Escape cancels."
            },
            announcements: {
              onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}.`,
              onDragOver: ({ active, over }) =>
                over ? `${titleOf(active.id)} is over position ${ids.indexOf(String(over.id)) + 1}.` : undefined,
              onDragEnd: ({ active, over }) =>
                over ? `Dropped ${titleOf(active.id)} at position ${ids.indexOf(String(over.id)) + 1}.` : `Dropped ${titleOf(active.id)}.`,
              onDragCancel: ({ active }) => `Cancelled. ${titleOf(active.id)} stayed in place.`
            }
          }}
        >
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <ol aria-label="Team pins in order" className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {team.map((doc, index) => (
                <SortablePin key={doc.documentId} doc={doc} index={index} count={team.length} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      )}
      {team.length < KB_MAX_TEAM_PINS ? (
        <div className={cn("flex items-center gap-2", team.length > 0 ? "mt-1.5 sm:w-1/2 sm:pr-0.5" : "mt-2")}>
          <span
            aria-hidden
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-dashed border-primary/30 text-xs tabular-nums text-muted-foreground"
          >
            {team.length + 1}
          </span>
          <p className="min-w-0 flex-1 rounded-md border border-dashed border-primary/30 px-3 py-1.5 text-xs text-muted-foreground">
            Open slot. Choose "Pin for the team" in a source's menu.
          </p>
        </div>
      ) : null}
    </section>
  );
}
