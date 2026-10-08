import { createContext, useContext, useId, useRef, useState } from "react";
import { Link } from "wouter";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Active,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
  type Over
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Ellipsis,
  FolderInput,
  FolderMinus,
  FolderOutput,
  FolderPlus,
  GripVertical,
  Megaphone,
  Pencil,
  Plus,
  Tags,
  Trash2
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  KB_DRAG_MOTION,
  KB_MAX_CATEGORY_DEPTH,
  nestBlockReason,
  subtreeDocumentIds,
  type KbCategoryNode,
  type KbTree
} from "@/lib/kbLibrary";
import { kbColorLabel } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem, KbLibraryColor } from "@/types/api";
import { CountLabel, UNCATEGORIZED_KEY } from "./KbBrowseViews";
import { useKbLibraryContext } from "./KbContext";
import { KbMenu, type KbMenuEntry } from "./KbMenu";
import { ColorDot, NewBadge, TagChips } from "./KbShared";
import { useReducedMotion } from "./useReducedMotion";

/**
 * Organize mode: the folder tree with drag handles. Drag a category onto the
 * top or bottom edge of another to place it beside that one, or onto its
 * middle to nest it inside. Drag a source onto a category name to move it
 * there, or between sources to reorder. Every move also exists in each
 * item's menu for keyboard and screen reader users.
 */

type DragData =
  | { type: "category"; categoryId: string; label: string }
  | { type: "document"; documentId: string; fromCategoryId: string | null; label: string };

type DropData =
  | { type: "category"; categoryId: string }
  | { type: "document"; documentId: string; categoryId: string | null }
  | { type: "uncategorized" };

interface DropTarget {
  dropId: string;
  place: "before" | "after" | "inside";
  valid: boolean;
  message: string;
}

const TargetContext = createContext<DropTarget | null>(null);

const collisionDetection: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

/** Current pointer height; keyboard drags fall back to the dragged item's center. */
function currentY(event: DragMoveEvent | DragEndEvent): number | null {
  const activator = event.activatorEvent as Partial<PointerEvent> | null;
  if (activator && typeof activator.clientY === "number") return activator.clientY + event.delta.y;
  const rect = event.active.rect.current.translated;
  return rect ? rect.top + rect.height / 2 : null;
}

function computeTarget(
  active: Active,
  over: Over | null,
  y: number | null,
  tree: KbTree
): DropTarget | null {
  const drag = active.data.current as DragData | undefined;
  const drop = over?.data.current as DropData | undefined;
  if (!drag || !drop || !over) return null;
  const dropId = String(over.id);
  const ratio = y === null || over.rect.height === 0 ? 0.5 : (y - over.rect.top) / over.rect.height;

  if (drag.type === "category") {
    if (drop.type !== "category" || drop.categoryId === drag.categoryId) return null;
    const target = tree.byId.get(drop.categoryId);
    if (!target) return null;
    const name = target.category.name;
    if (ratio > 0.3 && ratio < 0.7) {
      const reason = nestBlockReason(tree, drag.categoryId, drop.categoryId);
      return { dropId, place: "inside", valid: !reason, message: reason ?? `Nest inside ${name}` };
    }
    const place = ratio <= 0.3 ? "before" : "after";
    const reason = nestBlockReason(tree, drag.categoryId, target.category.parentId ?? null);
    return {
      dropId,
      place,
      valid: !reason,
      message: reason ?? `Place ${place} ${name}`
    };
  }

  const fromName = drag.fromCategoryId ? tree.byId.get(drag.fromCategoryId)?.category.name : null;
  if (drop.type === "uncategorized" || (drop.type === "document" && drop.categoryId === null)) {
    // A source that is already outside every category has nowhere to go here.
    if (!drag.fromCategoryId) return null;
    return { dropId, place: "inside", valid: true, message: `Remove from ${fromName ?? "this category"}` };
  }
  if (drop.type === "category") {
    const name = tree.byId.get(drop.categoryId)?.category.name ?? "category";
    return {
      dropId,
      place: "inside",
      valid: true,
      message: drop.categoryId === drag.fromCategoryId ? `Move to the end of ${name}` : `Move into ${name}`
    };
  }
  if (drop.documentId === drag.documentId && drop.categoryId === drag.fromCategoryId) return null;
  const place = ratio < 0.5 ? "before" : "after";
  const name = drop.categoryId ? tree.byId.get(drop.categoryId)?.category.name : null;
  return {
    dropId,
    place,
    valid: true,
    message:
      drop.categoryId === drag.fromCategoryId
        ? `Reorder in ${name ?? "this category"}`
        : `Move into ${name ?? "this category"}`
  };
}

function DropLabel({ target }: { target: DropTarget }): JSX.Element {
  return (
    <span
      className={cn(
        "absolute right-10 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium shadow-card",
        target.valid ? "bg-primary text-primary-foreground" : "bg-destructive text-destructive-foreground"
      )}
    >
      {target.message}
    </span>
  );
}

/**
 * Where a drop lands: an insertion line with its label ("Place before Fees")
 * between items, or a labeled dashed slot over the row when it goes inside.
 */
function DropIndicator({ dropId }: { dropId: string }): JSX.Element | null {
  const target = useContext(TargetContext);
  if (!target || target.dropId !== dropId) return null;
  if (target.place === "inside") {
    return (
      <span aria-hidden data-kb-drop-slot className="pointer-events-none absolute inset-0 z-10">
        <DropLabel target={target} />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      data-kb-drop-line
      className={cn(
        "pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full",
        target.valid ? "bg-primary" : "bg-destructive",
        target.place === "before" ? "-top-px" : "-bottom-px"
      )}
    >
      <span
        className={cn(
          "absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full",
          target.valid ? "bg-primary" : "bg-destructive"
        )}
      />
      <DropLabel target={target} />
    </span>
  );
}

/** Where a dragged item came from stays in place as a faded, dashed ghost. */
const GHOST = "rounded-md opacity-50 outline-dashed outline-1 -outline-offset-1 outline-primary/50";

function insideClass(dropId: string, target: DropTarget | null): string | false {
  if (!target || target.dropId !== dropId || target.place !== "inside") return false;
  return target.valid
    ? "rounded-md bg-primary/10 outline-dashed outline-2 -outline-offset-2 outline-primary/60"
    : "rounded-md bg-destructive/5 outline-dashed outline-2 -outline-offset-2 outline-destructive/60";
}

function DragHandle({
  label,
  setRef,
  attributes,
  listeners
}: {
  label: string;
  setRef: (el: HTMLElement | null) => void;
  attributes: ReturnType<typeof useDraggable>["attributes"];
  listeners: ReturnType<typeof useDraggable>["listeners"];
}): JSX.Element {
  return (
    <button
      ref={setRef}
      type="button"
      {...attributes}
      {...listeners}
      aria-label={label}
      title="Drag to move"
      className="btn-icon h-8 w-8 shrink-0 cursor-grab touch-none active:cursor-grabbing"
    >
      <GripVertical className="h-4 w-4" aria-hidden />
    </button>
  );
}

function OrganizeDoc({
  doc,
  categoryId,
  index,
  count
}: {
  doc: KbDocumentListItem;
  categoryId: string | null;
  index: number;
  count: number;
}): JSX.Element {
  const { lookup, actions, openDialog } = useKbLibraryContext();
  const target = useContext(TargetContext);
  const key = `doc:${categoryId ?? "none"}:${doc.documentId}`;
  const dropId = `drop-${key}`;
  const drag = useDraggable({
    id: key,
    data: { type: "document", documentId: doc.documentId, fromCategoryId: categoryId, label: doc.title } satisfies DragData
  });
  const drop = useDroppable({
    id: dropId,
    data: { type: "document", documentId: doc.documentId, categoryId } satisfies DropData
  });
  const categoryName = categoryId ? lookup.tree.byId.get(categoryId)?.category.name : null;

  const menu: KbMenuEntry[] = [];
  if (categoryId) {
    menu.push(
      {
        label: "Move up",
        icon: ArrowUp,
        disabled: index === 0,
        onSelect: () => actions.moveDocumentBy(doc.documentId, categoryId, -1)
      },
      {
        label: "Move down",
        icon: ArrowDown,
        disabled: index === count - 1,
        onSelect: () => actions.moveDocumentBy(doc.documentId, categoryId, 1)
      }
    );
  }
  menu.push({
    label: categoryId ? "Move to another category…" : "Move to a category…",
    icon: FolderInput,
    disabled: lookup.tree.order.length === 0,
    onSelect: () => openDialog({ kind: "doc-move", documentId: doc.documentId, fromCategoryId: categoryId })
  });
  if (categoryId) {
    menu.push({
      label: `Remove from ${categoryName ?? "this category"}`,
      icon: FolderMinus,
      onSelect: () => actions.moveDocument(doc.documentId, categoryId, null)
    });
  }
  menu.push(
    "separator",
    {
      label: "Categories…",
      icon: FolderInput,
      onSelect: () => openDialog({ kind: "doc-categories", documentId: doc.documentId })
    },
    {
      label: "Tags…",
      icon: Tags,
      onSelect: () => openDialog({ kind: "doc-tags", documentId: doc.documentId })
    },
    doc.featuredPosition !== null
      ? { label: "Remove team pin", icon: Megaphone, onSelect: () => actions.removeTeamPin(doc.documentId) }
      : { label: "Pin for the team", icon: Megaphone, onSelect: () => actions.addTeamPin(doc.documentId) }
  );

  return (
    <li
      ref={(el) => {
        drag.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={cn(
        "relative flex items-center gap-1 py-1 pl-1 pr-2 transition-colors duration-100 ease-out",
        drag.isDragging && GHOST,
        insideClass(dropId, target)
      )}
    >
      <DropIndicator dropId={dropId} />
      <DragHandle
        label={`Drag ${doc.title}`}
        setRef={drag.setActivatorNodeRef}
        attributes={drag.attributes}
        listeners={drag.listeners}
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          href={`/kb/${doc.documentId}`}
          className="min-w-0 truncate rounded-sm text-sm text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {doc.title}
        </Link>
        {doc.isNew ? <NewBadge /> : null}
        {doc.featuredPosition !== null ? (
          <span className="inline-flex items-center gap-1 text-xs text-primary">
            <Megaphone className="h-3 w-3" aria-hidden />
            Team pin
          </span>
        ) : null}
        <TagChips tagIds={doc.tagIds} tagsById={lookup.tagsById} />
      </div>
      <KbMenu label={`Organize ${doc.title}`} items={menu}>
        <Ellipsis className="h-4 w-4" aria-hidden />
      </KbMenu>
    </li>
  );
}

function OrganizeCategory({
  node,
  collapsed,
  onToggle,
  index,
  count
}: {
  node: KbCategoryNode;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  index: number;
  count: number;
}): JSX.Element {
  const { data, actions, openDialog } = useKbLibraryContext();
  const confirm = useConfirm();
  const target = useContext(TargetContext);
  const panelId = useId();
  const id = node.category.id;
  const dropId = `drop-cat:${id}`;
  const drag = useDraggable({
    id: `cat:${id}`,
    data: { type: "category", categoryId: id, label: node.category.name } satisfies DragData
  });
  const drop = useDroppable({ id: dropId, data: { type: "category", categoryId: id } satisfies DropData });
  const open = !collapsed.has(id);
  const docsById = new Map(data.items.map((d) => [d.documentId, d]));
  const docs = node.category.documentIds
    .map((docId) => docsById.get(docId))
    .filter((d): d is KbDocumentListItem => Boolean(d));
  // Same meaning as the browse view: every source in this category and the ones inside it.
  let total = 0;
  subtreeDocumentIds(node).forEach((docId) => {
    if (docsById.has(docId)) total += 1;
  });

  async function onDelete(): Promise<void> {
    const ok = await confirm({
      title: `Delete "${node.category.name}"?`,
      message:
        node.children.length > 0
          ? "Its subcategories move up one level. The sources in it stay in the library; they are only removed from this category."
          : "The sources in it stay in the library; they are only removed from this category.",
      confirmLabel: "Delete category",
      tone: "danger"
    });
    if (ok) actions.deleteCategory(id);
  }

  async function setTeamColor(color: KbLibraryColor): Promise<void> {
    if (color === node.category.color) return;
    const result = await actions.updateCategory(id, { color });
    if (!result.ok) actions.reportError(result.message);
  }

  const menu: KbMenuEntry[] = [
    {
      label: "Rename…",
      icon: Pencil,
      onSelect: () => openDialog({ kind: "category-edit", categoryId: id })
    },
    {
      kind: "swatches",
      label: "Team color",
      hint: "Everyone in this program sees it, unless they pick their own.",
      value: node.category.color,
      onSelect: (color) => void setTeamColor(color)
    },
    "separator",
    {
      label: "Add a subcategory…",
      icon: FolderPlus,
      disabled: node.depth >= KB_MAX_CATEGORY_DEPTH,
      onSelect: () => openDialog({ kind: "category-create", parentId: id })
    },
    "separator",
    { label: "Move up", icon: ArrowUp, disabled: index === 0, onSelect: () => actions.moveCategoryBy(id, -1) },
    {
      label: "Move down",
      icon: ArrowDown,
      disabled: index === count - 1,
      onSelect: () => actions.moveCategoryBy(id, 1)
    },
    {
      label: "Move to…",
      icon: FolderOutput,
      onSelect: () => openDialog({ kind: "category-move", categoryId: id })
    },
    "separator",
    { label: "Delete category…", icon: Trash2, danger: true, onSelect: () => void onDelete() }
  ];

  return (
    <li className={cn(drag.isDragging && GHOST)}>
      <div
        ref={(el) => {
          drag.setNodeRef(el);
          drop.setNodeRef(el);
        }}
        className={cn(
          "relative flex items-center gap-1 py-1 pl-1 pr-2 transition-colors duration-100 ease-out",
          insideClass(dropId, target)
        )}
      >
        <DropIndicator dropId={dropId} />
        <DragHandle
          label={`Drag category ${node.category.name}`}
          setRef={drag.setActivatorNodeRef}
          attributes={drag.attributes}
          listeners={drag.listeners}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(id)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-100",
              open && "rotate-90"
            )}
            aria-hidden
          />
          <ColorDot color={node.category.color} />
          <span className="min-w-0 truncate">{node.category.name}</span>
          <span className="sr-only">Team color: {kbColorLabel(node.category.color)}.</span>
          <CountLabel count={total} />
        </button>
        <KbMenu label={`Organize category ${node.category.name}`} items={menu}>
          <Ellipsis className="h-4 w-4" aria-hidden />
        </KbMenu>
      </div>
      <div id={panelId} hidden={!open} className="ml-5 border-l border-border pl-1">
        {open ? (
          <>
            {node.children.length > 0 ? (
              <ul aria-label={`Categories in ${node.category.name}`}>
                {node.children.map((child, i) => (
                  <OrganizeCategory
                    key={child.category.id}
                    node={child}
                    collapsed={collapsed}
                    onToggle={onToggle}
                    index={i}
                    count={node.children.length}
                  />
                ))}
              </ul>
            ) : null}
            {docs.length > 0 ? (
              <ul aria-label={`Sources in ${node.category.name}`}>
                {docs.map((doc, i) => (
                  <OrganizeDoc key={doc.documentId} doc={doc} categoryId={id} index={i} count={docs.length} />
                ))}
              </ul>
            ) : (
              <p className="px-3 py-1.5 text-xs text-muted-foreground">
                No sources yet. Drag a source onto the name {node.category.name} to add it.
              </p>
            )}
          </>
        ) : null}
      </div>
    </li>
  );
}

function UncategorizedGroup({
  docs,
  collapsed,
  onToggle
}: {
  docs: KbDocumentListItem[];
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}): JSX.Element {
  const target = useContext(TargetContext);
  const panelId = useId();
  const dropId = "drop-uncategorized";
  const drop = useDroppable({ id: dropId, data: { type: "uncategorized" } satisfies DropData });
  const open = !collapsed.has(UNCATEGORIZED_KEY);
  return (
    <li>
      <div
        ref={drop.setNodeRef}
        className={cn("relative flex items-center gap-1 py-1 pl-10 pr-2", insideClass(dropId, target))}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => onToggle(UNCATEGORIZED_KEY)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-sm font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn(
              "h-4 w-4 shrink-0 motion-safe:transition-transform motion-safe:duration-100",
              open && "rotate-90"
            )}
            aria-hidden
          />
          Not in a category
          <CountLabel count={docs.length} />
        </button>
      </div>
      <div id={panelId} hidden={!open} className="ml-5 border-l border-border pl-1">
        {open ? (
          docs.length > 0 ? (
            <ul aria-label="Sources not in a category">
              {docs.map((doc, i) => (
                <OrganizeDoc key={doc.documentId} doc={doc} categoryId={null} index={i} count={docs.length} />
              ))}
            </ul>
          ) : (
            <p className="px-3 py-1.5 text-xs text-muted-foreground">Every source is in a category.</p>
          )
        ) : null}
      </div>
    </li>
  );
}

export function KbOrganizeTree({
  collapsed,
  onToggle
}: {
  collapsed: Set<string>;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { data, lookup, actions, openDialog } = useKbLibraryContext();
  const reducedMotion = useReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor)
  );
  const [active, setActive] = useState<DragData | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const targetRef = useRef<DropTarget | null>(null);

  const loose = data.items
    .filter((d) => !d.categoryIds.some((id) => lookup.tree.byId.has(id)))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }));

  function updateTarget(next: DropTarget | null): void {
    const prev = targetRef.current;
    if (
      prev?.dropId === next?.dropId &&
      prev?.place === next?.place &&
      prev?.valid === next?.valid
    ) {
      return;
    }
    targetRef.current = next;
    setTarget(next);
  }

  function onDragStart(event: DragStartEvent): void {
    setActive((event.active.data.current as DragData | undefined) ?? null);
    updateTarget(null);
  }

  function onDragMove(event: DragMoveEvent): void {
    updateTarget(computeTarget(event.active, event.over, currentY(event), lookup.tree));
  }

  function reset(): void {
    setActive(null);
    updateTarget(null);
  }

  function onDragEnd(event: DragEndEvent): void {
    const drag = event.active.data.current as DragData | undefined;
    const drop = event.over?.data.current as DropData | undefined;
    const final = computeTarget(event.active, event.over, currentY(event), lookup.tree);
    reset();
    if (!drag || !drop || !final) return;
    if (!final.valid) {
      actions.reportError(final.message.endsWith(".") ? final.message : `${final.message}.`);
      return;
    }
    if (drag.type === "category" && drop.type === "category") {
      if (final.place === "inside") {
        actions.moveCategory(drag.categoryId, drop.categoryId);
      } else {
        const anchor = lookup.tree.byId.get(drop.categoryId);
        actions.moveCategory(
          drag.categoryId,
          anchor?.category.parentId ?? null,
          drop.categoryId,
          final.place
        );
      }
      return;
    }
    if (drag.type !== "document") return;
    if (drop.type === "uncategorized" || (drop.type === "document" && drop.categoryId === null)) {
      actions.moveDocument(drag.documentId, drag.fromCategoryId, null);
    } else if (drop.type === "category") {
      actions.moveDocument(drag.documentId, drag.fromCategoryId, drop.categoryId);
    } else if (drop.type === "document" && drop.categoryId) {
      actions.moveDocument(
        drag.documentId,
        drag.fromCategoryId,
        drop.categoryId,
        drop.documentId,
        final.place === "before" ? "before" : "after"
      );
    }
  }

  const labelOf = (a: Active): string => (a.data.current as DragData | undefined)?.label ?? "Item";

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={reset}
      accessibility={{
        screenReaderInstructions: {
          draggable:
            "To move, press space or enter, use the arrow keys, then press space or enter to drop. Escape cancels. Each item's menu also has move options."
        },
        announcements: {
          onDragStart: ({ active: a }) => `Picked up ${labelOf(a)}.`,
          onDragOver: () => targetRef.current?.message,
          onDragMove: () => undefined,
          onDragEnd: ({ active: a }) => `Dropped ${labelOf(a)}.`,
          onDragCancel: ({ active: a }) => `Cancelled. ${labelOf(a)} stayed in place.`
        }
      }}
    >
      <TargetContext.Provider value={target}>
        <div className="rounded-lg border border-border bg-card py-1 shadow-card">
          {lookup.tree.roots.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No categories yet. Use "New category" to create the first one.
            </p>
          ) : null}
          <ul aria-label="Library structure">
            {lookup.tree.roots.map((node, i) => (
              <OrganizeCategory
                key={node.category.id}
                node={node}
                collapsed={collapsed}
                onToggle={onToggle}
                index={i}
                count={lookup.tree.roots.length}
              />
            ))}
            <UncategorizedGroup docs={loose} collapsed={collapsed} onToggle={onToggle} />
          </ul>
          <div className="px-2 pb-1 pt-1.5">
            <button
              type="button"
              data-kb-new-category-row
              onClick={() => openDialog({ kind: "category-create", parentId: null })}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors duration-100 ease-out hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-4 w-4" aria-hidden />
              New category
            </button>
          </div>
        </div>
      </TargetContext.Provider>
      <DragOverlay modifiers={[offsetFromPointer]} dropAnimation={reducedMotion ? null : KB_DRAG_MOTION}>
        {active ? <DragPreview label={active.label} target={target} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * Keep the drag preview below and right of the pointer so the row under it,
 * the drop target, stays readable. Keyboard drags shift it below the item.
 */
const offsetFromPointer: Modifier = ({ activatorEvent, activeNodeRect, overlayNodeRect, transform }) => {
  if (!activeNodeRect) return transform;
  const point = activatorEvent ? getEventCoordinates(activatorEvent) : null;
  if (!point) return { ...transform, y: transform.y + activeNodeRect.height + 8 };
  const width = overlayNodeRect?.width ?? 0;
  const height = overlayNodeRect?.height ?? 0;
  // Pointer position now, in viewport coordinates.
  const x = point.x + transform.x;
  const y = point.y + transform.y;
  // Below and right of the pointer; flip above or left near the viewport edge.
  const left = x + 16 + width > window.innerWidth - 8 ? x - 16 - width : x + 16;
  const top = y + 16 + height > window.innerHeight - 8 ? y - 16 - height : y + 16;
  // The overlay renders at activeNodeRect plus the returned transform.
  return { ...transform, x: left - activeNodeRect.left, y: top - activeNodeRect.top };
};

function DragPreview({ label, target }: { label: string; target: DropTarget | null }): JSX.Element {
  return (
    <div className="inline-flex max-w-xs flex-col rounded-md border border-border bg-card px-3 py-1.5 shadow-panel">
      <span className="flex items-center gap-1.5 truncate text-sm font-medium">
        <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        {label}
      </span>
      {target ? (
        <span className={cn("mt-0.5 text-xs", target.valid ? "text-primary" : "text-destructive")}>
          {target.message}
        </span>
      ) : null}
    </div>
  );
}
