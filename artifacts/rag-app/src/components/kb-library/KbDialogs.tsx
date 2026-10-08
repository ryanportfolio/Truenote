import { useId, useState, type FormEvent } from "react";
import { Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  KB_CATEGORY_NAME_MAX,
  KB_MAX_CATEGORY_DEPTH,
  KB_TAG_NAME_MAX,
  categoryPathLabel,
  nestBlockReason,
  sortTags
} from "@/lib/kbLibrary";
import { KB_LIBRARY_COLORS, kbColorLabel } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbLibraryColor, KbTag } from "@/types/api";
import { useKbLibraryContext, type KbDialogState } from "./KbContext";
import { KbDialog, KbDialogActions, KbInlineError } from "./KbDialog";
import { ColorDot, ColorPicker, NoteForm } from "./KbShared";

const INDENT = ["pl-0", "pl-5", "pl-10", "pl-14"];
const inputClass =
  "w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2";

/** Renders whichever Sources dialog is open. */
export function KbDialogs({
  dialog,
  onClose,
  onReturn
}: {
  dialog: KbDialogState | null;
  onClose: () => void;
  onReturn: (dialog: KbDialogState) => void;
}): JSX.Element | null {
  if (!dialog) return null;
  // A dialog opened from inside another one returns to it when closed.
  const back = "returnTo" in dialog && dialog.returnTo ? dialog.returnTo : null;
  switch (dialog.kind) {
    case "note":
      return <NoteDialog documentId={dialog.documentId} onClose={onClose} />;
    case "doc-categories":
      return <DocCategoriesDialog documentId={dialog.documentId} onClose={onClose} />;
    case "doc-tags":
      return <DocTagsDialog documentId={dialog.documentId} onClose={onClose} />;
    case "manage-tags":
      return <ManageTagsDialog onClose={back ? () => onReturn(back) : onClose} />;
    case "category-create":
      return (
        <CategoryFormDialog parentId={dialog.parentId} onClose={back ? () => onReturn(back) : onClose} />
      );
    case "category-edit":
      return <CategoryFormDialog categoryId={dialog.categoryId} onClose={onClose} />;
    case "category-move":
      return <CategoryMoveDialog categoryId={dialog.categoryId} onClose={onClose} />;
    case "doc-move":
      return (
        <DocMoveDialog
          documentId={dialog.documentId}
          fromCategoryId={dialog.fromCategoryId}
          onClose={onClose}
        />
      );
    default:
      return null;
  }
}

function useDoc(documentId: string) {
  const { data } = useKbLibraryContext();
  return data.items.find((d) => d.documentId === documentId) ?? null;
}

function NoteDialog({ documentId, onClose }: { documentId: string; onClose: () => void }): JSX.Element | null {
  const { actions } = useKbLibraryContext();
  const doc = useDoc(documentId);
  if (!doc) return null;
  return (
    <KbDialog title="My note" description={doc.title} onClose={onClose}>
      <NoteForm
        initialNote={doc.note}
        onCancel={onClose}
        onSave={async (note) => {
          const result = await actions.saveNote(documentId, note);
          if (result.ok) onClose();
          return result;
        }}
      />
    </KbDialog>
  );
}

function DocCategoriesDialog({
  documentId,
  onClose
}: {
  documentId: string;
  onClose: () => void;
}): JSX.Element | null {
  const { lookup, actions, openDialog } = useKbLibraryContext();
  const doc = useDoc(documentId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(doc?.categoryIds ?? []));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!doc) return null;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!doc) return;
    if (selected.size > 50) {
      setError("A source can be in at most 50 categories.");
      return;
    }
    setPending(true);
    // Keep the source's current order of memberships, then the new ones in tree order.
    const ordered = [
      ...doc.categoryIds.filter((id) => selected.has(id)),
      ...lookup.tree.order.map((n) => n.category.id).filter((id) => selected.has(id) && !doc.categoryIds.includes(id))
    ];
    const result = await actions.setDocumentCategories(documentId, ordered);
    setPending(false);
    if (result.ok) onClose();
    else setError(result.message);
  }

  return (
    <KbDialog
      title="Categories"
      description={`Choose every category ${doc.title} belongs in. A source can sit in more than one.`}
      onClose={onClose}
      wide
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex min-h-0 flex-col">
        {lookup.tree.order.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No categories yet.{" "}
            <button
              type="button"
              className="cursor-pointer text-primary underline underline-offset-2"
              onClick={() =>
                openDialog({ kind: "category-create", parentId: null, returnTo: { kind: "doc-categories", documentId } })
              }
            >
              Create one
            </button>
            .
          </p>
        ) : (
          <fieldset className="min-h-0 overflow-y-auto rounded-md border border-border p-2">
            <legend className="sr-only">Categories</legend>
            {lookup.tree.order.map((node) => (
              <label
                key={node.category.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md py-1.5 pr-2 text-sm hover:bg-muted/40",
                  INDENT[node.depth - 1] ?? "pl-14"
                )}
              >
                <input
                  type="checkbox"
                  checked={selected.has(node.category.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(node.category.id);
                    else next.delete(node.category.id);
                    setSelected(next);
                  }}
                  className="ml-2 h-4 w-4 accent-primary"
                />
                <ColorDot color={node.category.color} />
                <span className="min-w-0 truncate">{node.category.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        <KbInlineError message={error} />
        <KbDialogActions>
          <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn-primary px-4 py-1.5 text-sm">
            {pending ? "Saving…" : "Save categories"}
          </button>
        </KbDialogActions>
      </form>
    </KbDialog>
  );
}

function DocTagsDialog({ documentId, onClose }: { documentId: string; onClose: () => void }): JSX.Element | null {
  const { data, actions, openDialog } = useKbLibraryContext();
  const doc = useDoc(documentId);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(doc?.tagIds ?? []));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!doc) return null;
  const tags = sortTags(data.tags);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (selected.size > 30) {
      setError("A source can have at most 30 tags.");
      return;
    }
    setPending(true);
    const ids = tags.map((t) => t.id).filter((id) => selected.has(id));
    const result = await actions.setDocumentTags(documentId, ids);
    setPending(false);
    if (result.ok) onClose();
    else setError(result.message);
  }

  return (
    <KbDialog title="Tags" description={doc.title} onClose={onClose}>
      <form onSubmit={(e) => void onSubmit(e)} className="flex min-h-0 flex-col">
        {tags.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tags yet.</p>
        ) : (
          <fieldset className="flex min-h-0 flex-wrap gap-2 overflow-y-auto">
            <legend className="sr-only">Tags</legend>
            {tags.map((tag) => {
              const checked = selected.has(tag.id);
              return (
                <label
                  key={tag.id}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                    checked ? "border-foreground/40 bg-muted font-medium" : "border-border bg-card"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(tag.id);
                      else next.delete(tag.id);
                      setSelected(next);
                    }}
                    className="h-4 w-4 accent-primary"
                  />
                  <ColorDot color={tag.color} />
                  {tag.name}
                </label>
              );
            })}
          </fieldset>
        )}
        <button
          type="button"
          onClick={() => openDialog({ kind: "manage-tags", returnTo: { kind: "doc-tags", documentId } })}
          className="mt-3 self-start text-sm text-primary underline underline-offset-2"
        >
          Create or edit tags
        </button>
        <KbInlineError message={error} />
        <KbDialogActions>
          <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={pending || tags.length === 0} className="btn-primary px-4 py-1.5 text-sm">
            {pending ? "Saving…" : "Save tags"}
          </button>
        </KbDialogActions>
      </form>
    </KbDialog>
  );
}

function ColorSelect({
  value,
  onChange,
  label
}: {
  value: KbLibraryColor;
  onChange: (color: KbLibraryColor) => void;
  label: string;
}): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <ColorDot color={value} />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as KbLibraryColor)}
        className="select-quiet rounded-md border border-input bg-card py-1.5 pl-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      >
        {KB_LIBRARY_COLORS.map((c) => (
          <option key={c} value={c}>
            {kbColorLabel(c)}
          </option>
        ))}
      </select>
    </span>
  );
}

function TagEditRow({ tag, onError }: { tag: KbTag; onError: (message: string | null) => void }): JSX.Element {
  const { data, actions } = useKbLibraryContext();
  const confirm = useConfirm();
  const [name, setName] = useState(tag.name);
  const used = data.items.filter((d) => d.tagIds.includes(tag.id)).length;

  async function saveName(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === tag.name) return;
    if (!trimmed) {
      setName(tag.name);
      onError("A tag needs a name.");
      return;
    }
    const result = await actions.updateTag(tag.id, { name: trimmed });
    if (!result.ok) {
      setName(tag.name);
      onError(result.message);
    } else onError(null);
  }

  async function remove(): Promise<void> {
    const ok = await confirm({
      title: `Delete the tag "${tag.name}"?`,
      message:
        used > 0
          ? `It comes off ${used} ${used === 1 ? "source" : "sources"}. The sources stay in the library.`
          : "No sources use it yet.",
      confirmLabel: "Delete tag",
      tone: "danger"
    });
    if (!ok) return;
    const result = await actions.deleteTag(tag.id);
    onError(result.ok ? null : result.message);
  }

  return (
    <li className="flex items-center gap-2 py-2">
      <input
        aria-label={`Name of tag ${tag.name}`}
        value={name}
        maxLength={KB_TAG_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void saveName();
          }
        }}
        className={cn(inputClass, "min-w-0 flex-1 py-1.5")}
      />
      <ColorSelect
        value={tag.color}
        label={`Color of tag ${tag.name}`}
        onChange={(color) =>
          void actions.updateTag(tag.id, { color }).then((r) => onError(r.ok ? null : r.message))
        }
      />
      <span className="hidden w-16 shrink-0 text-right tabular-nums text-xs text-muted-foreground sm:inline">
        {used} {used === 1 ? "use" : "uses"}
      </span>
      <button
        type="button"
        onClick={() => void remove()}
        aria-label={`Delete tag ${tag.name}`}
        title="Delete tag"
        className="btn-icon h-8 w-8 shrink-0 hover:text-destructive"
      >
        <Trash2 className="h-4 w-4" aria-hidden />
      </button>
    </li>
  );
}

function ManageTagsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { data, actions } = useKbLibraryContext();
  const [name, setName] = useState("");
  const [color, setColor] = useState<KbLibraryColor>("slate");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const tags = sortTags(data.tags);

  async function onCreate(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A tag needs a name.");
      return;
    }
    setPending(true);
    const result = await actions.createTag({ name: trimmed, color });
    setPending(false);
    if (result.ok) {
      setName("");
      setError(null);
    } else setError(result.message);
  }

  return (
    <KbDialog
      title="Manage tags"
      description="Tags help everyone filter sources. Rename one and every source using it updates."
      onClose={onClose}
      wide
    >
      <form onSubmit={(e) => void onCreate(e)} className="flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <label htmlFor={nameId} className="text-sm font-medium">
            New tag
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={KB_TAG_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="For example: Billing"
            className={cn(inputClass, "mt-1")}
          />
        </div>
        <ColorSelect value={color} onChange={setColor} label="Color of the new tag" />
        <button type="submit" disabled={pending} className="btn-whisper shrink-0 px-4 py-2 text-sm">
          {pending ? "Adding…" : "Add tag"}
        </button>
      </form>
      <KbInlineError message={error} />
      {tags.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No tags yet. Add the first one above.</p>
      ) : (
        <ul aria-label="Tags" className="mt-4 min-h-0 divide-y divide-border overflow-y-auto border-t border-border">
          {tags.map((tag) => (
            <TagEditRow key={tag.id} tag={tag} onError={setError} />
          ))}
        </ul>
      )}
      <KbDialogActions>
        <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
          Done
        </button>
      </KbDialogActions>
    </KbDialog>
  );
}

function CategoryFormDialog({
  categoryId,
  parentId: initialParentId = null,
  onClose
}: {
  categoryId?: string;
  parentId?: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const { lookup, actions } = useKbLibraryContext();
  const existing = categoryId ? lookup.tree.byId.get(categoryId)?.category : undefined;
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<KbLibraryColor>(existing?.color ?? "slate");
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const parentFieldId = useId();
  const errorId = useId();
  if (categoryId && !existing) return null;

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("A category needs a name.");
      return;
    }
    setPending(true);
    const result = existing
      ? await actions.updateCategory(existing.id, {
          ...(trimmed !== existing.name ? { name: trimmed } : {}),
          ...(color !== existing.color ? { color } : {})
        })
      : await actions.createCategory({ name: trimmed, color, parentId });
    setPending(false);
    if (result.ok) onClose();
    else setError(result.message);
  }

  return (
    <KbDialog
      title={existing ? "Edit category" : "New category"}
      description={
        existing
          ? categoryPathLabel(lookup.tree.byId.get(existing.id))
          : "Categories group sources the way your team thinks about them."
      }
      onClose={onClose}
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        <div>
          <label htmlFor={nameId} className="text-sm font-medium">
            Name
          </label>
          <input
            id={nameId}
            data-autofocus
            value={name}
            maxLength={KB_CATEGORY_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            placeholder="For example: Billing"
            className={cn(inputClass, "mt-1")}
          />
        </div>
        <ColorPicker
          legend="Team color"
          hint="Everyone in this program sees it, unless they pick their own."
          value={color}
          onChange={setColor}
        />
        {!existing ? (
          <div>
            <label htmlFor={parentFieldId} className="text-sm font-medium">
              Inside
            </label>
            <select
              id={parentFieldId}
              value={parentId ?? ""}
              onChange={(e) => setParentId(e.target.value || null)}
              className={cn(inputClass, "select-quiet mt-1")}
            >
              <option value="">Top level</option>
              {lookup.tree.order
                .filter((n) => n.depth < KB_MAX_CATEGORY_DEPTH)
                .map((n) => (
                  <option key={n.category.id} value={n.category.id}>
                    {categoryPathLabel(n)}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
        <div id={errorId}>
          <KbInlineError message={error} />
        </div>
        <KbDialogActions>
          <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn-primary px-4 py-1.5 text-sm">
            {pending ? "Saving…" : existing ? "Save category" : "Create category"}
          </button>
        </KbDialogActions>
      </form>
    </KbDialog>
  );
}

interface RadioOption {
  id: string | null;
  label: string;
  depth: number;
  disabledReason?: string | null;
  note?: string;
  color?: KbLibraryColor;
}

function RadioList({
  legend,
  options,
  value,
  onChange
}: {
  legend: string;
  options: RadioOption[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
}): JSX.Element {
  const name = useId();
  return (
    <fieldset className="min-h-0 overflow-y-auto rounded-md border border-border p-2">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const disabled = Boolean(option.disabledReason);
        return (
          <label
            key={option.id ?? "__top"}
            className={cn(
              "flex items-center gap-2 rounded-md py-1.5 pr-2 text-sm",
              INDENT[Math.max(0, option.depth - 1)] ?? "pl-14",
              disabled ? "cursor-not-allowed text-muted-foreground" : "cursor-pointer hover:bg-muted/40"
            )}
            title={option.disabledReason ?? undefined}
          >
            <input
              type="radio"
              name={name}
              disabled={disabled}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
              className="ml-2 h-4 w-4 accent-primary"
            />
            {option.color ? <ColorDot color={option.color} /> : null}
            <span className="min-w-0 truncate">{option.label}</span>
            {option.note ? <span className="shrink-0 text-xs text-muted-foreground">{option.note}</span> : null}
            {option.disabledReason ? <span className="sr-only">{option.disabledReason}</span> : null}
          </label>
        );
      })}
    </fieldset>
  );
}

function CategoryMoveDialog({ categoryId, onClose }: { categoryId: string; onClose: () => void }): JSX.Element | null {
  const { lookup, actions } = useKbLibraryContext();
  const node = lookup.tree.byId.get(categoryId);
  const currentParent = node?.category.parentId ?? null;
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  if (!node) return null;

  const options: RadioOption[] = [
    { id: null, label: "Top level", depth: 1, note: currentParent === null ? "Current" : undefined },
    ...lookup.tree.order.map((n) => ({
      id: n.category.id,
      label: n.category.name,
      depth: n.depth,
      color: n.category.color,
      note: n.category.id === currentParent ? "Current" : undefined,
      disabledReason:
        n.category.id === categoryId
          ? "A category can't be moved inside itself."
          : nestBlockReason(lookup.tree, categoryId, n.category.id)
    }))
  ];

  return (
    <KbDialog
      title={`Move "${node.category.name}"`}
      description="Choose where it goes. It lands at the end of that level, with everything inside it."
      onClose={onClose}
      wide
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice === undefined) return;
          onClose();
          actions.moveCategory(categoryId, choice);
        }}
      >
        <RadioList legend="Destination" options={options} value={choice} onChange={setChoice} />
        <KbDialogActions>
          <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="submit"
            disabled={choice === undefined || choice === currentParent}
            className="btn-primary px-4 py-1.5 text-sm"
          >
            Move category
          </button>
        </KbDialogActions>
      </form>
    </KbDialog>
  );
}

function DocMoveDialog({
  documentId,
  fromCategoryId,
  onClose
}: {
  documentId: string;
  fromCategoryId: string | null;
  onClose: () => void;
}): JSX.Element | null {
  const { lookup, actions } = useKbLibraryContext();
  const doc = useDoc(documentId);
  const [choice, setChoice] = useState<string | null | undefined>(undefined);
  if (!doc) return null;
  const fromName = fromCategoryId ? lookup.tree.byId.get(fromCategoryId)?.category.name : null;

  const options: RadioOption[] = lookup.tree.order.map((n) => ({
    id: n.category.id,
    label: n.category.name,
    depth: n.depth,
    color: n.category.color,
    note: n.category.id === fromCategoryId ? "Current" : doc.categoryIds.includes(n.category.id) ? "Also here" : undefined
  }));

  return (
    <KbDialog
      title={`Move "${doc.title}"`}
      description={
        fromName
          ? `It leaves ${fromName} and goes to the end of the category you choose. Use Categories… to keep it in several.`
          : "It goes to the end of the category you choose."
      }
      onClose={onClose}
      wide
    >
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!choice) return;
          onClose();
          actions.moveDocument(documentId, fromCategoryId, choice);
        }}
      >
        <RadioList legend="Destination category" options={options} value={choice} onChange={setChoice} />
        <KbDialogActions>
          <button type="button" onClick={onClose} className="btn-whisper px-4 py-1.5 text-sm">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!choice || choice === fromCategoryId}
            className="btn-primary px-4 py-1.5 text-sm"
          >
            Move source
          </button>
        </KbDialogActions>
      </form>
    </KbDialog>
  );
}
