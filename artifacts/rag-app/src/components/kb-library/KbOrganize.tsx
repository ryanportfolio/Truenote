import { useEffect, useId, useRef, useState } from "react";
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
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, Ellipsis, Eye, FileText, GripVertical, Plus, Search, Tags, X } from "lucide-react";
import {
  KB_DRAG_MOTION,
  KB_MAX_TEAM_PINS,
  docCategoryPaths,
  moveItem,
  sortDocs,
  teamPins,
  type KbOrganizeStep
} from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbCsrPreview } from "./KbCsrPreview";
import { pathsLabel } from "./KbDocRow";
import { KbMenu } from "./KbMenu";
import { KbOrganizeTree } from "./KbOrganizeTree";
import { useReducedMotion } from "./useReducedMotion";

const STEPS: Array<{ id: KbOrganizeStep; label: string }> = [
  { id: "shortcuts", label: "Team shortcuts" },
  { id: "folders", label: "Folders" }
];

function TeamSlot({ doc, index, count }: { doc: KbDocumentListItem; index: number; count: number }): JSX.Element {
  const { actions, lookup, markMoved } = useKbLibraryContext();
  const reducedMotion = useReducedMotion();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: doc.documentId, transition: reducedMotion ? null : KB_DRAG_MOTION });
  const path = pathsLabel(docCategoryPaths(doc, lookup.tree));
  const move = (delta: number): void => {
    markMoved(`doc:${doc.documentId}`);
    actions.moveTeamPinBy(doc.documentId, delta);
  };
  return (
    <li
      ref={setNodeRef}
      data-kb-team-slot={index + 1}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex min-w-0 items-center gap-3", isDragging && "relative z-30")}
    >
      <span
        aria-hidden
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-primary/30 bg-card text-sm font-medium tabular-nums text-primary"
      >
        {index + 1}
      </span>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1 rounded-lg border border-border bg-card py-1 pl-1 pr-1 shadow-card",
          isDragging && "shadow-panel"
        )}
      >
        <button
          ref={setActivatorNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          aria-label={`Drag ${doc.title} to reorder team shortcuts`}
          className="btn-icon h-9 w-9 cursor-grab touch-none active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={doc.title}>
            <span className="sr-only">Position {index + 1}: </span>
            {doc.title}
          </span>
          {path ? <span className="block truncate text-xs text-muted-foreground">{path}</span> : null}
        </span>
        <KbMenu
          label={`Team shortcut ${index + 1}: ${doc.title}`}
          title="Move or remove"
          items={[
            { label: "Move earlier", icon: ArrowUp, disabled: index === 0, onSelect: () => move(-1) },
            { label: "Move later", icon: ArrowDown, disabled: index === count - 1, onSelect: () => move(1) },
            "separator",
            {
              label: "Remove from team shortcuts",
              icon: X,
              onSelect: () => {
                markMoved(`doc:${doc.documentId}`);
                actions.removeTeamPin(doc.documentId);
              }
            }
          ]}
        >
          <Ellipsis className="h-4 w-4" aria-hidden />
        </KbMenu>
      </div>
    </li>
  );
}

/** Step 1: the team shortcuts lane, numbered and reorderable, with its capacity. */
function TeamLane({ team }: { team: KbDocumentListItem[] }): JSX.Element {
  const { actions, markMoved } = useKbLibraryContext();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const ids = team.map((d) => d.documentId);
  const titleOf = (id: string | number): string => team.find((d) => d.documentId === id)?.title ?? "Source";

  function onDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    markMoved(`doc:${String(active.id)}`);
    void actions.setTeamPins(moveItem(ids, from, to), `Moved ${titleOf(active.id)} to position ${to + 1}.`);
  }

  return (
    <section aria-labelledby="kb-team-lane" className="rounded-lg border border-border bg-card p-3 shadow-card sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 id="kb-team-lane" className="font-display text-2xl font-semibold tracking-tight">
          Team shortcuts
        </h3>
        <p data-kb-team-capacity className="text-sm tabular-nums text-muted-foreground">
          {team.length} of {KB_MAX_TEAM_PINS}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Everyone on your team sees these first on their shortcuts shelf, in this order. Drag to reorder.
      </p>
      {team.length > 0 ? (
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
                over
                  ? `Dropped ${titleOf(active.id)} at position ${ids.indexOf(String(over.id)) + 1}.`
                  : `Dropped ${titleOf(active.id)}.`,
              onDragCancel: ({ active }) => `Cancelled. ${titleOf(active.id)} stayed in place.`
            }
          }}
        >
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ol aria-label="Team shortcuts in order" className="mt-4 flex flex-col gap-2">
              {team.map((doc, index) => (
                <TeamSlot key={doc.documentId} doc={doc} index={index} count={team.length} />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      ) : null}
      {team.length < KB_MAX_TEAM_PINS ? (
        <div className={cn("flex items-center gap-3", team.length > 0 ? "mt-2" : "mt-4")}>
          <span
            aria-hidden
            className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-dashed border-primary/40 text-sm tabular-nums text-muted-foreground"
          >
            {team.length + 1}
          </span>
          <p className="min-w-0 flex-1 rounded-lg border-2 border-dashed border-border px-3 py-2.5 text-sm text-muted-foreground">
            Open slot. Add a source from the list below.
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** Step 1: find a source and add it to team shortcuts. */
function AddSource({ team }: { team: KbDocumentListItem[] }): JSX.Element {
  const { data, lookup, actions, markMoved } = useKbLibraryContext();
  const [query, setQuery] = useState("");
  const fieldId = useId();
  const full = team.length >= KB_MAX_TEAM_PINS;
  const q = query.trim().toLowerCase();
  const candidates = sortDocs(
    data.items.filter((d) => d.featuredPosition === null && (!q || d.title.toLowerCase().includes(q))),
    "views"
  );
  return (
    <section aria-labelledby="kb-add-source" className="rounded-lg border border-border bg-card p-3 shadow-card sm:p-5">
      <h3 id="kb-add-source" className="text-xl font-semibold tracking-tight">
        Add a source
      </h3>
      <label htmlFor={fieldId} className="sr-only">
        Find a source to add
      </label>
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          id={fieldId}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a source"
          className="w-full rounded-md border border-input bg-card py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        />
      </div>
      {full ? (
        <p className="mt-2 text-sm text-muted-foreground">
          Team shortcuts are full. Remove one to add another.
        </p>
      ) : null}
      {candidates.length > 0 ? (
        <ul aria-label="Sources you can add" className="mt-3 max-h-80 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {candidates.map((doc) => {
            const path = pathsLabel(docCategoryPaths(doc, lookup.tree));
            return (
              <li key={doc.documentId} className="flex items-center gap-3 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{doc.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{path || "Not in a folder"}</span>
                </span>
                <button
                  type="button"
                  disabled={full}
                  onClick={() => {
                    markMoved(`doc:${doc.documentId}`);
                    actions.addTeamPin(doc.documentId);
                  }}
                  aria-label={`Add ${doc.title} to team shortcuts`}
                  className="btn-whisper shrink-0 gap-1 px-3 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  Add
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          {q ? `No other sources match "${query.trim()}".` : "Every source is already a team shortcut."}
        </p>
      )}
    </section>
  );
}

/** Step 2: the folder tree in a card with New folder and Manage tags. */
function FoldersStep({
  collapsed,
  onToggle
}: {
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { openDialog } = useKbLibraryContext();
  return (
    <section aria-labelledby="kb-folders-step" className="rounded-lg border border-border bg-card p-3 shadow-card sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 id="kb-folders-step" className="font-display text-2xl font-semibold tracking-tight">
          Folders
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => openDialog({ kind: "manage-tags" })}
            className="btn-icon gap-1.5 whitespace-nowrap px-2.5 text-sm"
          >
            <Tags className="h-4 w-4" aria-hidden />
            Manage tags
          </button>
          <button
            type="button"
            data-kb-new-folder
            onClick={() => openDialog({ kind: "category-create", parentId: null })}
            className="btn-icon gap-1.5 whitespace-nowrap px-2.5 text-sm font-medium text-primary hover:text-primary"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New folder
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Drag a source or folder onto another folder to move it. Each row&apos;s menu has the same moves.
      </p>
      <div className="mt-4">
        <KbOrganizeTree collapsed={collapsed} onToggle={onToggle} />
      </div>
    </section>
  );
}

/**
 * Organize for managers: two steps ("1 Team shortcuts", "2 Folders"), one
 * primary Done, and from 1280px a live preview of what the team will see
 * beside the editor (a Preview toggle swaps it in below that). Every change
 * saves as it is made.
 */
export function KbOrganize({
  step,
  onStep,
  onDone,
  wide,
  collapsed,
  onToggle,
  lastMoved
}: {
  step: KbOrganizeStep;
  onStep: (step: KbOrganizeStep) => void;
  onDone: () => void;
  /** 1280px and wider: the preview sits beside the editor. */
  wide: boolean;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  /** The item just moved, so the preview can point at it. */
  lastMoved: { key: string; at: number } | null;
}): JSX.Element {
  const { data } = useKbLibraryContext();
  const [previewOpen, setPreviewOpen] = useState(false);
  const stepRef = useRef<HTMLButtonElement>(null);
  const team = teamPins(data.items);

  // Focus lands on the current step when Organize opens.
  useEffect(() => {
    stepRef.current?.focus();
  }, []);

  const editor =
    step === "shortcuts" ? (
      <div className="flex min-w-0 flex-col gap-5">
        <TeamLane team={team} />
        <AddSource team={team} />
      </div>
    ) : (
      <FoldersStep collapsed={collapsed} onToggle={onToggle} />
    );

  return (
    <div data-kb-organize className="flex flex-col gap-5">
      <h2 className="sr-only">Organize</h2>
      <div data-kb-organize-bar className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ol aria-label="Organize steps" className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {STEPS.map((s, i) => {
              const current = s.id === step;
              return (
                <li key={s.id} className="flex items-center gap-3">
                  {i > 0 ? <span aria-hidden className="hidden h-px w-16 bg-border sm:block" /> : null}
                  <button
                    ref={current ? stepRef : undefined}
                    type="button"
                    aria-current={current ? "step" : undefined}
                    data-kb-step={s.id}
                    onClick={() => onStep(s.id)}
                    className="group flex cursor-pointer items-center gap-2.5 rounded-full py-1 pr-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "grid h-9 w-9 place-items-center rounded-full text-base font-medium tabular-nums",
                        current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:bg-muted/70"
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className={cn(current ? "font-medium text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                      <span className="sr-only">Step {i + 1}: </span>
                      {s.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="flex items-center gap-2">
            {!wide ? (
              <button
                type="button"
                aria-pressed={previewOpen}
                data-kb-csr-preview-toggle
                onClick={() => setPreviewOpen((v) => !v)}
                className={cn(
                  "btn-whisper gap-1.5 px-4 py-2 text-sm",
                  previewOpen && "border-primary/40 bg-primary/5 text-primary hover:text-primary"
                )}
              >
                <Eye className="h-4 w-4" aria-hidden />
                Preview
              </button>
            ) : null}
            <button type="button" data-kb-done onClick={onDone} className="btn-primary px-6 py-2 text-base">
              Done
            </button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">Changes save automatically. Your team sees them right away.</p>
      </div>

      {wide ? (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,24rem)] items-start gap-5">
          {editor}
          <KbCsrPreview lastMoved={lastMoved} />
        </div>
      ) : previewOpen ? (
        <KbCsrPreview lastMoved={lastMoved} onBack={() => setPreviewOpen(false)} />
      ) : (
        editor
      )}
    </div>
  );
}
