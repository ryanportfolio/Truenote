import { useId, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
  type Modifier
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useReducedMotion } from "@/components/kb-library/useReducedMotion";
import { KB_DRAG_MOTION } from "@/lib/kbLibrary";
import {
  dragSelection,
  firstName,
  focusKeysFor,
  idsToMove,
  memberCount,
  peopleLabel,
  shownSupervisorId,
  teamCounts,
  teamLabel,
  visibleCsrs,
  type TeamsFilter
} from "@/lib/teamsView";
import { cn } from "@/lib/utils";
import type { TeamsCsr, TeamsSupervisor } from "@/types/api";
import { FilterPill, MoveMenu, SearchField, SelectionBar, SupervisorChip } from "./shared";

/**
 * Roster view: "All CSRs" on the left (search, All / Unassigned, checkboxes,
 * drag handles), one card per supervisor on the right plus an Unassigned
 * zone. Drop a row or a member chip on a card to move that person; a
 * checked row carries every checked row with it. Keyboard drags step
 * through the cards with the arrow keys. Same dnd-kit setup as the
 * library's organize tree (KbOrganizeTree.tsx).
 */

interface DragData {
  /** "row:<csr id>" (left list) or "chip:<csr id>" (team card), also the handle's data attribute. */
  key: string;
  csrId: string;
  name: string;
  /** Rows carry the checked rows with them; chips move one person. */
  fromRow: boolean;
}

interface DropData {
  supervisorId: string | null;
  /** "Renee Alvarez's team" or "Unassigned". */
  label: string;
}

interface ActiveDrag {
  key: string;
  ids: string[];
  label: string;
}

const UNASSIGNED_DROP_ID = "team:none";

function dropIdFor(supervisorId: string | null): string {
  return supervisorId ? `team:${supervisorId}` : UNASSIGNED_DROP_ID;
}

function supervisorIdFor(dropId: string): string | null {
  return dropId === UNASSIGNED_DROP_ID ? null : dropId.slice("team:".length);
}

/** Where a dragged person came from stays in place as a faded, dashed ghost (the organize tree's GHOST). */
const GHOST = "opacity-50 outline-dashed outline-1 -outline-offset-1 outline-primary/50";

function isKeyboardEvent(event: Event | null): boolean {
  return typeof KeyboardEvent !== "undefined" && event instanceof KeyboardEvent;
}

function dropElement(dropId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-teams-drop="${CSS.escape(dropId)}"]`);
}

/**
 * After a keyboard drop, focus the moved person's handle or chip once it is
 * drawn in its new place (a chip remounts in another card, so dnd-kit's own
 * focus return lands on nothing). When the dragged row or chip is gone (a
 * filtered list, a chip moved to Unassigned), the same person's other
 * handle takes focus.
 */
function focusDragHandle(key: string): void {
  const keys = focusKeysFor(key);
  let frames = 0;
  const attempt = (): void => {
    frames += 1;
    let el: HTMLElement | null = null;
    for (const k of keys) {
      el = document.querySelector<HTMLElement>(`[data-teams-drag="${CSS.escape(k)}"]`);
      if (el) break;
    }
    if (el && document.activeElement !== el) el.focus({ preventScroll: false });
    if (frames < 12) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

export function RosterView({
  supervisors,
  csrs,
  canEdit,
  selected,
  onSelectedChange,
  onMove
}: {
  supervisors: TeamsSupervisor[];
  csrs: TeamsCsr[];
  canEdit: boolean;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onMove: (csrIds: readonly string[], supervisorId: string | null) => Promise<boolean>;
}): JSX.Element {
  const reducedMotion = useReducedMotion();
  const [active, setActive] = useState<ActiveDrag | null>(null);
  const activeRef = useRef<ActiveDrag | null>(null);
  // Kept past the end of a drag: the cancel announcement runs after reset().
  const lastLabel = useRef("");
  const [overId, setOverId] = useState<string | null>(null);
  const keyboardTarget = useRef<string | null>(null);
  const keyboardDrag = useRef(false);
  // The dragged node's rect when the drag started; the overlay is drawn from there.
  const origin = useRef<{ top: number; left: number } | null>(null);

  const dropLabels = useMemo(() => {
    const map = new Map<string, string>([[UNASSIGNED_DROP_ID, "Unassigned"]]);
    for (const s of supervisors) map.set(dropIdFor(s.id), teamLabel(s.name));
    return map;
  }, [supervisors]);
  const overLabel = (id: string | null): string | undefined => (id ? dropLabels.get(id) : undefined);

  // Keyboard drags: arrows step through the team cards (and Unassigned) in screen order.
  const [keyboardCoordinates] = useState(() => {
    const getter: KeyboardCoordinateGetter = (event, { context }) => {
      const forward = event.code === "ArrowDown" || event.code === "ArrowRight";
      const back = event.code === "ArrowUp" || event.code === "ArrowLeft";
      if (!forward && !back) return undefined;
      event.preventDefault();
      const { collisionRect, droppableRects, droppableContainers } = context;
      if (!collisionRect) return undefined;
      const targets = droppableContainers
        .getEnabled()
        .map((container) => ({ id: String(container.id), rect: droppableRects.get(container.id) }))
        .filter((t): t is { id: string; rect: NonNullable<typeof t.rect> } => Boolean(t.rect))
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      if (targets.length === 0) return undefined;
      const at = targets.findIndex((t) => t.id === keyboardTarget.current);
      const nextIndex =
        at === -1 ? (forward ? 0 : targets.length - 1) : (at + (forward ? 1 : -1) + targets.length) % targets.length;
      const next = targets[nextIndex];
      if (!next) return undefined;
      keyboardTarget.current = next.id;
      setOverId(next.id);
      return { x: next.rect.left + 16, y: next.rect.top + 16 };
    };
    return getter;
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates })
  );

  // Pointer drags: the card under the pointer. Keyboard drags: the card the arrows reached.
  const [collisionDetection] = useState(() => {
    const detect: CollisionDetection = (args) => {
      if (args.pointerCoordinates) return pointerWithin(args);
      const container = args.droppableContainers.find((c) => String(c.id) === keyboardTarget.current);
      return container ? [{ id: container.id, data: { droppableContainer: container, value: 0 } }] : [];
    };
    return detect;
  });

  // The preview sits beside the pointer, or in the top right of the card a keyboard drag reached.
  const [followPointer] = useState(() => {
    const modifier: Modifier = ({ activatorEvent, activeNodeRect, overlayNodeRect, transform }) => {
      if (!activeNodeRect) return transform;
      origin.current ??= { top: activeNodeRect.top, left: activeNodeRect.left };
      const base = origin.current;
      const width = overlayNodeRect?.width ?? 0;
      const height = overlayNodeRect?.height ?? 0;
      if (isKeyboardEvent(activatorEvent)) {
        const card = keyboardTarget.current ? dropElement(keyboardTarget.current) : null;
        if (!card) return transform;
        const r = card.getBoundingClientRect();
        const left = Math.max(r.left + 12, r.right - width - 16);
        return { ...transform, x: left - base.left, y: r.top + 16 - base.top };
      }
      const point = activatorEvent ? getEventCoordinates(activatorEvent) : null;
      if (!point) return transform;
      const x = point.x + transform.x;
      const y = point.y + transform.y;
      const left = x + 14 + width > window.innerWidth - 8 ? x - 14 - width : x + 14;
      const top = y + 14 + height > window.innerHeight - 8 ? y - 14 - height : y + 14;
      return { ...transform, x: left - base.left, y: top - base.top };
    };
    return modifier;
  });

  const counts = useMemo(() => teamCounts(supervisors, csrs), [supervisors, csrs]);
  const supervisorById = useMemo(() => new Map(supervisors.map((s) => [s.id, s])), [supervisors]);
  const membersOf = (supervisorId: string | null): TeamsCsr[] =>
    csrs.filter((csr) => shownSupervisorId(csr, supervisors) === supervisorId);
  const draggingIds = useMemo(() => new Set(active?.ids ?? []), [active]);

  /** Nothing would change: everyone in the drag is already on that team. */
  const isNoop = (dropId: string | null): boolean => {
    if (!active || !dropId) return false;
    return idsToMove(csrs, active.ids, supervisorIdFor(dropId)).length === 0;
  };

  function reset(): void {
    keyboardTarget.current = null;
    origin.current = null;
    activeRef.current = null;
    setActive(null);
    setOverId(null);
  }

  function onDragStart(event: DragStartEvent): void {
    const drag = event.active.data.current as DragData | undefined;
    keyboardDrag.current = isKeyboardEvent(event.activatorEvent);
    keyboardTarget.current = null;
    origin.current = null;
    if (!drag) return;
    const ids = drag.fromRow ? dragSelection(drag.csrId, selected) : [drag.csrId];
    const names = ids.map((id) => csrs.find((c) => c.id === id)?.name ?? drag.name);
    const next = { key: drag.key, ids, label: peopleLabel(names) };
    activeRef.current = next;
    lastLabel.current = next.label;
    setActive(next);
    setOverId(null);
  }

  function onDragOver(event: DragOverEvent): void {
    if (keyboardDrag.current) return;
    setOverId(event.over ? String(event.over.id) : null);
  }

  function onDragEnd(event: DragEndEvent): void {
    const drag = activeRef.current;
    const keyboard = isKeyboardEvent(event.activatorEvent);
    const dropId = keyboard ? keyboardTarget.current : event.over ? String(event.over.id) : null;
    reset();
    if (!drag || !dropId || !dropLabels.has(dropId)) return;
    if (keyboard) focusDragHandle(drag.key);
    void onMove(drag.ids, supervisorIdFor(dropId)).then((ok) => {
      if (ok && drag.ids.length > 1) onSelectedChange(new Set());
    });
  }

  const instructions =
    "To move a person, press space or enter on them, use the arrow keys to pick a team, then press space or enter to drop. Escape cancels. A checked person brings every checked person along. Move to does the same from the selection bar.";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      // The drop hint opens inside the card under the pointer; cards below it move.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
      accessibility={{
        screenReaderInstructions: { draggable: instructions },
        announcements: {
          onDragStart: () => (activeRef.current ? `Picked up ${activeRef.current.label}.` : undefined),
          onDragOver: ({ over }) =>
            keyboardDrag.current ? undefined : over ? `Over ${overLabel(String(over.id)) ?? "a team"}.` : undefined,
          onDragMove: () =>
            keyboardDrag.current && keyboardTarget.current
              ? `Over ${overLabel(keyboardTarget.current) ?? "a team"}.`
              : undefined,
          // A real move is announced once the server accepts it.
          onDragEnd: ({ over }) => (over ? undefined : "Dropped outside a team. Nobody moved."),
          onDragCancel: () => `Cancelled. ${lastLabel.current || "Everyone"} stayed in place.`
        }
      }}
    >
      {/* Read-only (a supervisor): their team card alone; the CSR list would repeat it. */}
      <div className={cn("grid items-start gap-6", canEdit && "lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]")}>
        {canEdit ? (
          <CsrListCard
            supervisors={supervisors}
            csrs={csrs}
            selected={selected}
            onSelectedChange={onSelectedChange}
            onMove={onMove}
            unassignedCount={counts.unassigned}
            draggingIds={draggingIds}
            supervisorById={supervisorById}
          />
        ) : null}
        <div className="flex min-w-0 flex-col gap-4">
          {supervisors.map((s) => (
            <TeamCard
              key={s.id}
              supervisor={s}
              members={membersOf(s.id)}
              canEdit={canEdit}
              dragging={active !== null}
              over={overId === dropIdFor(s.id)}
              noop={overId === dropIdFor(s.id) && isNoop(overId)}
              draggingIds={draggingIds}
            />
          ))}
          {canEdit ? (
            <UnassignedZone
              members={membersOf(null)}
              dragging={active !== null}
              over={overId === UNASSIGNED_DROP_ID}
              noop={overId === UNASSIGNED_DROP_ID && isNoop(overId)}
              draggingIds={draggingIds}
            />
          ) : null}
        </div>
      </div>
      <DragOverlay
        modifiers={[followPointer]}
        dropAnimation={reducedMotion ? null : KB_DRAG_MOTION}
        // Keyboard steps glide between cards (none under reduced motion); pointer drags follow the pointer.
        transition={(activator) =>
          isKeyboardEvent(activator)
            ? reducedMotion
              ? "none"
              : `transform ${KB_DRAG_MOTION.duration}ms ${KB_DRAG_MOTION.easing}`
            : undefined
        }
      >
        {active ? <DragPreview label={active.label} target={overLabel(overId) ?? null} noop={isNoop(overId)} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

// ---------------------------------------------------------------------------
// Left: All CSRs

function CsrListCard({
  supervisors,
  csrs,
  selected,
  onSelectedChange,
  onMove,
  unassignedCount,
  draggingIds,
  supervisorById
}: {
  supervisors: TeamsSupervisor[];
  csrs: TeamsCsr[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onMove: (csrIds: readonly string[], supervisorId: string | null) => Promise<boolean>;
  unassignedCount: number;
  draggingIds: ReadonlySet<string>;
  supervisorById: Map<string, TeamsSupervisor>;
}): JSX.Element {
  const headingId = useId();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TeamsFilter>({ kind: "all" });
  // Unassigned people are counted against the supervisors shown, so a stale id reads as unassigned.
  const shown = useMemo(
    () =>
      visibleCsrs(
        csrs.map((csr) => ({ ...csr, supervisorId: shownSupervisorId(csr, supervisors) })),
        filter,
        query
      ),
    [csrs, supervisors, filter, query]
  );

  function toggle(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  }

  function moveSelected(supervisorId: string | null): void {
    const ids = [...selected];
    void onMove(ids, supervisorId).then((ok) => {
      if (ok) onSelectedChange(new Set());
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-5 shadow-card">
      <h2 id={headingId} className="text-xl font-semibold tracking-tight">
        All CSRs
      </h2>
      <SearchField id={searchId} value={query} onChange={setQuery} className="mt-4" />
      <div role="group" aria-label="Show" className="mt-3 flex flex-wrap items-center gap-2">
        <FilterPill
          pressed={filter.kind === "all"}
          onClick={() => setFilter({ kind: "all" })}
          label="All"
          count={csrs.length}
        />
        <FilterPill
          pressed={filter.kind === "unassigned"}
          onClick={() => setFilter({ kind: "unassigned" })}
          label="Unassigned"
          count={unassignedCount}
        />
      </div>
      {shown.length === 0 ? (
        <p className="mt-4 border-t border-border pt-4 text-sm text-muted-foreground">
          {query.trim()
            ? `No one matches "${query.trim()}".`
            : filter.kind === "unassigned"
              ? "Everyone is on a team."
              : "No CSRs yet."}
        </p>
      ) : (
        <ul aria-label="CSRs" className="mt-4 border-b border-border">
          {shown.map((csr) => (
            <CsrRow
              key={csr.id}
              csr={csr}
              supervisorName={csr.supervisorId ? firstName(supervisorById.get(csr.supervisorId)?.name ?? "") : null}
              checked={selected.has(csr.id)}
              onToggle={(on) => toggle(csr.id, on)}
              ghost={draggingIds.has(csr.id)}
            />
          ))}
        </ul>
      )}
      {selected.size > 0 ? (
        <SelectionBar
          count={selected.size}
          onClear={() => onSelectedChange(new Set())}
          label="Selected CSRs"
          className="mt-4"
        >
          <MoveMenu label="Move to…" supervisors={supervisors} onPick={moveSelected} />
        </SelectionBar>
      ) : null}
    </section>
  );
}

function CsrRow({
  csr,
  supervisorName,
  checked,
  onToggle,
  ghost
}: {
  csr: TeamsCsr;
  supervisorName: string | null;
  checked: boolean;
  onToggle: (on: boolean) => void;
  ghost: boolean;
}): JSX.Element {
  const checkboxId = useId();
  const key = `row:${csr.id}`;
  const drag = useDraggable({
    id: key,
    data: { key, csrId: csr.id, name: csr.name, fromRow: true } satisfies DragData
  });
  return (
    <li
      ref={drag.setNodeRef}
      className={cn(
        "flex items-center gap-3 border-t border-border py-1.5 transition-colors duration-100 ease-out hover:bg-muted/40",
        ghost && GHOST
      )}
    >
      <input
        id={checkboxId}
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        className="ml-1 h-4 w-4 shrink-0 cursor-pointer accent-primary"
      />
      <label htmlFor={checkboxId} className="min-w-0 flex-1 cursor-pointer break-words py-1 text-sm">
        {csr.name}
      </label>
      <SupervisorChip name={supervisorName} />
      <button
        ref={drag.setActivatorNodeRef}
        type="button"
        {...drag.attributes}
        {...drag.listeners}
        data-teams-drag={key}
        aria-label={`Drag ${csr.name}`}
        title="Drag to move"
        className="btn-icon h-8 w-8 shrink-0 cursor-grab touch-none rounded-full active:cursor-grabbing"
      >
        <GripVertical className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Right: team cards and the Unassigned zone

function DropHint({ text, noop }: { text: string; noop: boolean }): JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        "mt-4 rounded-lg border-2 border-dashed px-4 py-3 text-center text-sm font-medium motion-safe:animate-in motion-safe:fade-in motion-safe:[animation-duration:120ms]",
        noop ? "border-border text-muted-foreground" : "border-primary/60 bg-primary/5 text-primary"
      )}
    >
      {text}
    </div>
  );
}

function MemberChip({
  csr,
  canEdit,
  ghost
}: {
  csr: TeamsCsr;
  canEdit: boolean;
  ghost: boolean;
}): JSX.Element {
  const key = `chip:${csr.id}`;
  const drag = useDraggable({
    id: key,
    disabled: !canEdit,
    data: { key, csrId: csr.id, name: csr.name, fromRow: false } satisfies DragData
  });
  if (!canEdit) {
    return (
      <li className="inline-flex max-w-full items-center rounded-full border border-border bg-secondary px-3 py-1 text-sm">
        <span className="min-w-0 break-words">{csr.name}</span>
      </li>
    );
  }
  return (
    <li ref={drag.setNodeRef} className={cn("max-w-full rounded-full", ghost && GHOST)}>
      <button
        ref={drag.setActivatorNodeRef}
        type="button"
        {...drag.attributes}
        {...drag.listeners}
        data-teams-drag={key}
        aria-label={`Drag ${csr.name}`}
        title="Drag to move"
        className="btn-base max-w-full cursor-grab touch-none gap-1.5 border border-border bg-secondary py-1 pl-2 pr-3 font-normal text-foreground hover:border-foreground/20 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 break-words text-left">{csr.name}</span>
      </button>
    </li>
  );
}

function TeamCard({
  supervisor,
  members,
  canEdit,
  dragging,
  over,
  noop,
  draggingIds
}: {
  supervisor: TeamsSupervisor;
  members: TeamsCsr[];
  canEdit: boolean;
  dragging: boolean;
  over: boolean;
  noop: boolean;
  draggingIds: ReadonlySet<string>;
}): JSX.Element {
  const headingId = useId();
  const dropId = dropIdFor(supervisor.id);
  const drop = useDroppable({
    id: dropId,
    disabled: !canEdit,
    data: { supervisorId: supervisor.id, label: teamLabel(supervisor.name) } satisfies DropData
  });
  const showHint = canEdit && dragging && over;
  return (
    <section
      ref={drop.setNodeRef}
      data-teams-drop={dropId}
      aria-labelledby={headingId}
      className={cn(
        "rounded-lg border bg-card p-5 shadow-card transition-colors duration-100 ease-out",
        showHint && !noop ? "border-primary/60 bg-primary/5" : "border-border"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="min-w-0 break-words text-lg font-semibold tracking-tight">
          {supervisor.name}
        </h2>
        <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          Supervisor
        </span>
      </div>
      <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">{memberCount(members.length)}</p>
      {members.length > 0 ? (
        <ul aria-label={`Members of ${teamLabel(supervisor.name)}`} className="mt-4 flex flex-wrap gap-2">
          {members.map((csr) => (
            <MemberChip key={csr.id} csr={csr} canEdit={canEdit} ghost={draggingIds.has(csr.id)} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {canEdit ? "No one on this team yet. Drag a person here." : "No one on this team yet."}
        </p>
      )}
      {showHint ? (
        <DropHint
          noop={noop}
          text={
            noop
              ? `Already on ${firstName(supervisor.name)}'s team.`
              : `Drop to add to ${firstName(supervisor.name)}'s team.`
          }
        />
      ) : null}
    </section>
  );
}

function UnassignedZone({
  members,
  dragging,
  over,
  noop,
  draggingIds
}: {
  members: TeamsCsr[];
  dragging: boolean;
  over: boolean;
  noop: boolean;
  draggingIds: ReadonlySet<string>;
}): JSX.Element {
  const headingId = useId();
  const drop = useDroppable({
    id: UNASSIGNED_DROP_ID,
    data: { supervisorId: null, label: "Unassigned" } satisfies DropData
  });
  const showHint = dragging && over;
  return (
    <section
      ref={drop.setNodeRef}
      data-teams-drop={UNASSIGNED_DROP_ID}
      aria-labelledby={headingId}
      className={cn(
        "rounded-lg border border-dashed p-5 transition-colors duration-100 ease-out",
        showHint && !noop ? "border-primary/60 bg-primary/5" : "border-foreground/20 bg-card/60"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          Unassigned
        </h2>
        <SupervisorChip name={null} />
      </div>
      <p className="mt-0.5 text-sm tabular-nums text-muted-foreground">
        {members.length === 1 ? "1 person" : `${members.length} people`} without a supervisor
      </p>
      {members.length > 0 ? (
        <ul aria-label="Unassigned CSRs" className="mt-4 flex flex-wrap gap-2">
          {members.map((csr) => (
            <MemberChip key={csr.id} csr={csr} canEdit ghost={draggingIds.has(csr.id)} />
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Drag someone here to take them off their team.</p>
      )}
      {showHint ? <DropHint noop={noop} text={noop ? "Already unassigned." : "Drop to unassign."} /> : null}
    </section>
  );
}

function DragPreview({ label, target, noop }: { label: string; target: string | null; noop: boolean }): JSX.Element {
  return (
    <div className="inline-flex max-w-xs flex-col rounded-md border border-border bg-card px-3 py-1.5 shadow-panel">
      <span className="flex items-center gap-1.5 truncate text-sm font-medium">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {label}
      </span>
      {target ? (
        <span className={cn("mt-0.5 text-xs", noop ? "text-muted-foreground" : "text-primary")}>
          {noop ? (target === "Unassigned" ? "Already unassigned" : `Already on ${target}`) : `Move to ${target}`}
        </span>
      ) : null}
    </div>
  );
}
