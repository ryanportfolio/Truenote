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
import { ArrowLeft, ArrowRight, Bookmark, GripVertical, Megaphone, X } from "lucide-react";
import { moveItem } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { NewBadge, NoteIndicator, PinToggle } from "./KbShared";
import { useReducedMotion } from "./useReducedMotion";

/** Compact pinned source: title link plus the personal controls. */
function PinCard({ doc, personal }: { doc: KbDocumentListItem; personal: boolean }): JSX.Element {
  const { actions, openDialog } = useKbLibraryContext();
  return (
    <li className="relative flex min-w-0 items-center gap-2 rounded-md border border-border bg-card py-1 pl-3 pr-1 shadow-card transition-colors duration-100 ease-out focus-within:z-20 hover:z-20 hover:bg-muted/40">
      <Link
        href={`/kb/${doc.documentId}`}
        className="min-w-0 flex-1 truncate rounded-sm py-1 text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        title={doc.title}
      >
        {doc.title}
      </Link>
      <span className="relative z-10 flex shrink-0 items-center">
        {doc.isNew ? <NewBadge /> : null}
        <NoteIndicator doc={doc} onOpen={() => openDialog({ kind: "note", documentId: doc.documentId })} />
        {personal ? (
          <PinToggle doc={doc} onToggle={() => actions.togglePin(doc.documentId)} />
        ) : null}
      </span>
    </li>
  );
}

/**
 * The special place above the library: manager-chosen team pins, then the
 * user's own pins (newest pin first). Hidden while searching or filtering so
 * results sit at the top.
 */
export function KbPinStrips({
  team,
  mine,
  showMineHint
}: {
  team: KbDocumentListItem[];
  mine: KbDocumentListItem[];
  showMineHint: boolean;
}): JSX.Element | null {
  if (team.length === 0 && mine.length === 0 && !showMineHint) return null;
  return (
    <div className="flex flex-col gap-3">
      {team.length > 0 ? (
        <section
          aria-labelledby="kb-team-pins"
          className="rounded-lg border border-primary/20 bg-primary/5 p-3"
        >
          <h2
            id="kb-team-pins"
            className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-primary"
          >
            <Megaphone className="h-3.5 w-3.5" aria-hidden />
            Team pins
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              Chosen by your manager
            </span>
          </h2>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {team.map((doc) => (
              <PinCard key={doc.documentId} doc={doc} personal={false} />
            ))}
          </ul>
        </section>
      ) : null}
      {mine.length > 0 ? (
        <section aria-labelledby="kb-my-pins" className="rounded-lg border border-border bg-secondary p-3">
          <h2
            id="kb-my-pins"
            className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            <Bookmark className="h-3.5 w-3.5" fill="currentColor" aria-hidden />
            My pins
          </h2>
          <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
            {mine.map((doc) => (
              <PinCard key={doc.documentId} doc={doc} personal />
            ))}
          </ul>
        </section>
      ) : showMineHint ? (
        <p className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <Bookmark className="h-3.5 w-3.5" aria-hidden />
          Pin sources you use often with the bookmark button. They stay here, at the top.
        </p>
      ) : null}
    </div>
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
    useSortable({ id: doc.documentId, transition: reducedMotion ? null : undefined });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md border border-border bg-card py-1 pl-1 pr-1 shadow-card",
        isDragging && "relative z-30 shadow-panel"
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
        <span className="mr-1.5 tabular-nums text-xs text-muted-foreground">{index + 1}.</span>
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
    </li>
  );
}

/** Organize mode: team pins as a reorderable strip. */
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
      <h2
        id="kb-team-pins-edit"
        className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wide text-primary"
      >
        <Megaphone className="h-3.5 w-3.5" aria-hidden />
        Team pins
      </h2>
      <p className="mt-1 px-1 text-xs text-muted-foreground">
        Everyone in this program sees these first, in this order. Add more from a source's menu (up to 12).
      </p>
      {team.length === 0 ? (
        <p className="mt-2 px-1 text-sm text-muted-foreground">
          No team pins yet. Open a source's menu and choose "Pin for the team".
        </p>
      ) : (
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
            <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
              {team.map((doc, index) => (
                <SortablePin key={doc.documentId} doc={doc} index={index} count={team.length} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
