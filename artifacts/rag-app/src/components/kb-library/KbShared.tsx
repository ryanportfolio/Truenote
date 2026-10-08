import { useId, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent } from "react";
import { Bookmark, CircleSlash, Folder, Lock, NotebookPen, Palette, Pencil, Star } from "lucide-react";
import {
  KB_LIBRARY_COLORS,
  kbColorChip,
  kbColorDot,
  kbColorFolder,
  kbColorLabel,
  kbLabelName
} from "@/lib/kbLibraryColors";
import { KB_NOTE_MAX, docStatus } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbColorLabel, KbDocumentListItem, KbLibraryColor, KbTag } from "@/types/api";
import { KbDialogActions, KbInlineError } from "./KbDialog";
import { KbMenu, type KbMenuEntry } from "./KbMenu";
import type { ActionResult } from "./useKbLibrary";

export function NewBadge(): JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-primary/25 bg-primary/5 px-2 py-0 text-xs font-medium text-primary">
      New
    </span>
  );
}

export function ColorDot({ color, className }: { color: KbLibraryColor; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-full", className)}
      style={kbColorDot(color)}
    />
  );
}

/**
 * The user's private color on a source: a 4px stripe on the row's left edge
 * plus a spoken label, so the color is never the only cue. The parent must be
 * positioned.
 */
export function SourceColorStripe({ color }: { color: KbLibraryColor | null }): JSX.Element | null {
  if (!color) return null;
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute inset-y-1 left-0 w-1 rounded-r-full"
      style={kbColorDot(color)}
    />
  );
}

/** Screen reader text for a source's private label (its color, plus the user's name for it when given). */
export function SourceColorLabel({
  color,
  labels
}: {
  color: KbLibraryColor | null;
  labels?: readonly KbColorLabel[];
}): JSX.Element | null {
  if (!color) return null;
  const name = kbLabelName(color, labels);
  return (
    <span className="sr-only">
      Label: {kbColorLabel(color)}
      {name ? `, ${name}` : ""}.
    </span>
  );
}

export function TagChip({ tag }: { tag: KbTag }): JSX.Element {
  return (
    <span
      className="inline-flex max-w-[12rem] items-center truncate rounded-full border px-2 py-0 text-xs text-foreground"
      style={kbColorChip(tag.color)}
      title={tag.name}
    >
      {tag.name}
    </span>
  );
}

/** Up to `max` tag chips, then "+N more". */
export function TagChips({
  tagIds,
  tagsById,
  max = 3
}: {
  tagIds: string[];
  tagsById: Map<string, KbTag>;
  max?: number;
}): JSX.Element | null {
  const tags = tagIds.map((id) => tagsById.get(id)).filter((t): t is KbTag => Boolean(t));
  if (tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <>
      <span className="sr-only">Tags:</span>
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {rest > 0 ? (
        <span
          className="text-xs text-muted-foreground"
          title={tags.slice(max).map((t) => t.name).join(", ")}
        >
          +{rest} more
        </span>
      ) : null}
    </>
  );
}

export function PinToggle({
  doc,
  onToggle,
  className
}: {
  doc: KbDocumentListItem;
  onToggle: () => void;
  className?: string;
}): JSX.Element {
  const pinned = doc.pinnedAt !== null;
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={`Add ${doc.title} to my shortcuts`}
      title={pinned ? "In my shortcuts" : "Add to my shortcuts"}
      onClick={onToggle}
      className={cn("btn-icon h-8 w-8", pinned && "text-primary hover:text-primary", className)}
    >
      <Bookmark className="h-4 w-4" fill={pinned ? "currentColor" : "none"} aria-hidden />
    </button>
  );
}

function notePreview(note: string): string {
  return note.length > 280 ? `${note.slice(0, 280).trimEnd()}…` : note;
}

/** Shown only when the user has a note: opens the editor, previews on hover or focus. */
export function NoteIndicator({
  doc,
  onOpen,
  className
}: {
  doc: KbDocumentListItem;
  onOpen: () => void;
  className?: string;
}): JSX.Element | null {
  const tooltipId = useId();
  if (!doc.note) return null;
  return (
    <span className="group/note relative inline-flex">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Edit my note on ${doc.title}`}
        aria-describedby={tooltipId}
        className={cn("btn-icon h-8 w-8 text-foreground", className)}
      >
        <NotebookPen className="h-4 w-4" aria-hidden />
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-30 mt-1 hidden w-72 max-w-[80vw] whitespace-pre-wrap break-words rounded-md border border-border bg-card p-3 text-left text-xs leading-relaxed text-foreground shadow-panel group-focus-within/note:block group-hover/note:block motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100"
      >
        <span className="mb-1 block font-medium text-muted-foreground">My note</span>
        {notePreview(doc.note)}
      </span>
    </span>
  );
}

/**
 * Views and citations over the last 30 days, each with its word ("12 views",
 * "3 cited") so no number stands alone next to an icon.
 */
export function DocCounts({ doc, always = false }: { doc: KbDocumentListItem; always?: boolean }): JSX.Element {
  return (
    <span
      className={cn(
        "items-center gap-3 whitespace-nowrap tabular-nums text-xs text-muted-foreground",
        always ? "inline-flex" : "hidden sm:inline-flex"
      )}
    >
      <span title="Times anyone in the program opened it in the last 30 days">
        <span aria-hidden>
          {doc.viewCount} {doc.viewCount === 1 ? "view" : "views"}
        </span>
        <span className="sr-only">
          Opened {doc.viewCount} {doc.viewCount === 1 ? "time" : "times"} in the last 30 days.
        </span>
      </span>
      <span title="Answers that cited it in the last 30 days">
        <span aria-hidden>{doc.citationCount} cited</span>
        <span className="sr-only">
          Cited in {doc.citationCount} {doc.citationCount === 1 ? "answer" : "answers"} in the last 30 days.
        </span>
      </span>
    </span>
  );
}

/**
 * The user's private note shown in place under a source, so it reads without
 * hovering. The card says it is private; Edit opens the note editor.
 */
export function NoteCard({
  doc,
  onEdit,
  className
}: {
  doc: KbDocumentListItem;
  onEdit: () => void;
  className?: string;
}): JSX.Element | null {
  if (!doc.note) return null;
  return (
    <div
      className={cn(
        "relative z-10 mb-1 mt-0.5 flex max-w-xl items-start gap-2 rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-xs",
        className
      )}
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground">
          <span className="font-medium uppercase tracking-wide">My note</span>
          <span> · only you can see it</span>
        </p>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words leading-relaxed text-foreground" title={doc.note}>
          {doc.note}
        </p>
      </div>
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit my note on ${doc.title}`}
        className="btn-icon -my-0.5 h-7 shrink-0 gap-1 px-2 text-xs"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden />
        Edit
      </button>
    </div>
  );
}

/** Color button for one source: opens the "My color" picker. */
export function SourceColorMenu({
  doc,
  onSelect,
  className
}: {
  doc: KbDocumentListItem;
  onSelect: (color: KbLibraryColor | null) => void;
  className?: string;
}): JSX.Element {
  const current = doc.myColor ? `, now ${kbColorLabel(doc.myColor)}` : "";
  return (
    <KbMenu
      label={`My color for ${doc.title}${current}`}
      title={doc.myColor ? `My color: ${kbColorLabel(doc.myColor)}` : "My color"}
      buttonClassName={cn("btn-icon h-8 w-8", className)}
      items={myColorEntries(doc.myColor, onSelect)}
    >
      {doc.myColor ? (
        <span
          aria-hidden
          className="h-3.5 w-3.5 rounded-full border border-foreground/15"
          style={kbColorDot(doc.myColor)}
        />
      ) : (
        <Palette className="h-4 w-4" aria-hidden />
      )}
    </KbMenu>
  );
}

/** "My color" swatches plus "No color", shared by the row, reader and row menu. */
export function myColorEntries(
  value: KbLibraryColor | null,
  onSelect: (color: KbLibraryColor | null) => void
): KbMenuEntry[] {
  return [
    {
      kind: "swatches",
      label: "My color",
      hint: "Only you can see this.",
      value,
      onSelect: (color) => onSelect(color)
    },
    {
      label: "No color",
      icon: CircleSlash,
      radio: true,
      checked: value === null,
      onSelect: () => {
        if (value !== null) onSelect(null);
      }
    }
  ];
}

/** Swatch radio group for category and tag colors. */
export function ColorPicker({
  value,
  onChange,
  legend,
  hint
}: {
  value: KbLibraryColor;
  onChange: (color: KbLibraryColor) => void;
  legend: string;
  /** One line under the legend, such as who sees the color. */
  hint?: string;
}): JSX.Element {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset aria-describedby={hint ? hintId : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      {hint ? (
        <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        {KB_LIBRARY_COLORS.map((color) => (
          <label key={color} className="cursor-pointer" title={kbColorLabel(color)}>
            <input
              type="radio"
              name={name}
              value={color}
              checked={value === color}
              onChange={() => onChange(color)}
              className="peer sr-only"
            />
            <span className="sr-only">{kbColorLabel(color)}</span>
            <span
              aria-hidden
              className="block h-7 w-7 rounded-full border border-foreground/15 transition-shadow duration-100 ease-out peer-checked:ring-2 peer-checked:ring-foreground/70 peer-checked:ring-offset-2 peer-checked:ring-offset-card peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2"
              style={kbColorDot(color)}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Private note editor shared by the Sources dialog and the document page.
 * Escape cancels, Ctrl or Cmd plus Enter saves. Saving an empty note deletes it.
 */
export function NoteForm({
  initialNote,
  onSave,
  onCancel,
  autoFocus = false
}: {
  initialNote: string | null;
  onSave: (note: string) => Promise<ActionResult>;
  onCancel: () => void;
  /** Inline use; inside KbDialog the dialog focuses the field itself. */
  autoFocus?: boolean;
}): JSX.Element {
  const [value, setValue] = useState(initialNote ?? "");
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const helpId = useId();
  const unchanged = value.trim() === (initialNote ?? "").trim();
  // The first focus that is not a click puts the caret after the existing text, so typing adds to the note.
  const caretPlaced = useRef(false);

  function onFocus(event: FocusEvent<HTMLTextAreaElement>): void {
    if (caretPlaced.current) return;
    caretPlaced.current = true;
    const end = event.currentTarget.value.length;
    event.currentTarget.setSelectionRange(end, end);
  }

  async function save(note: string, kind: "save" | "delete"): Promise<void> {
    setPending(kind);
    setError(null);
    const result = await onSave(note);
    setPending(null);
    if (!result.ok) setError(result.message);
  }

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    if (pending || unchanged) return;
    void save(value, "save");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!pending && !unchanged) void save(value, "save");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col">
      <label htmlFor={fieldId} className="sr-only">
        My note
      </label>
      <textarea
        id={fieldId}
        data-autofocus
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onPointerDown={() => {
          caretPlaced.current = true;
        }}
        maxLength={KB_NOTE_MAX}
        rows={6}
        aria-describedby={helpId}
        placeholder="What do you want to remember about this source?"
        className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
      <div id={helpId} className="mt-1.5 flex items-center justify-end gap-3 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {value.length} / {KB_NOTE_MAX}
        </span>
      </div>
      <KbInlineError message={error} />
      <KbDialogActions
        start={
          initialNote ? (
            <button
              type="button"
              onClick={() => void save("", "delete")}
              disabled={pending !== null}
              className="btn-base border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
            >
              {pending === "delete" ? "Deleting…" : "Delete note"}
            </button>
          ) : null
        }
      >
        <button type="button" onClick={onCancel} className="btn-whisper px-4 py-1.5 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={pending !== null || unchanged} className="btn-primary px-4 py-1.5 text-sm">
          {pending === "save" ? "Saving…" : "Save note"}
        </button>
      </KbDialogActions>
    </form>
  );
}

// ---------------------------------------------------------------------------
// v3 quiet-row pieces

/** Star button: the source is in my shortcuts when filled. */
export function StarToggle({
  doc,
  onToggle,
  className
}: {
  doc: Pick<KbDocumentListItem, "title" | "pinnedAt">;
  onToggle: () => void;
  className?: string;
}): JSX.Element {
  const on = doc.pinnedAt !== null;
  const label = on ? `Remove ${doc.title} from my shortcuts` : `Add ${doc.title} to my shortcuts`;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={on ? "In my shortcuts" : "Add to my shortcuts"}
      onClick={onToggle}
      data-kb-star
      className={cn("btn-icon h-9 w-9", on && "text-primary hover:text-primary", className)}
    >
      <Star className="h-[18px] w-[18px]" fill={on ? "currentColor" : "none"} aria-hidden />
    </button>
  );
}

/** At most one status: "Updated" beats "New". */
export function StatusPill({ doc }: { doc: Pick<KbDocumentListItem, "isNew" | "createdAt"> }): JSX.Element | null {
  const status = docStatus(doc);
  if (!status) return null;
  return (
    <span
      data-kb-status={status}
      className="inline-flex shrink-0 items-center rounded-full border border-primary/25 bg-primary/5 px-2.5 py-0.5 text-xs font-medium text-primary"
    >
      {status === "updated" ? "Updated" : "New"}
    </span>
  );
}

/** Pale-yellow personal note tint (the reader's annotation yellow, never a status color). */
export const NOTE_STICKY_STYLE = { backgroundColor: "oklch(var(--highlight-yellow) / 0.28)" } as const;

/**
 * A private note under a source title: one line on a pale-yellow sticky with a
 * lock. The full text is in the reader and in the tooltip on hover or focus.
 */
export function NoteSticky({ note, className }: { note: string | null; className?: string }): JSX.Element | null {
  if (!note) return null;
  return (
    <p
      data-kb-note
      title={note}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-sm text-foreground",
        className
      )}
      style={NOTE_STICKY_STYLE}
    >
      <Lock className="h-3.5 w-3.5 shrink-0 text-foreground/70" aria-hidden />
      <span className="sr-only">My notes: </span>
      <span className="min-w-0 truncate">{note}</span>
    </p>
  );
}

/** A folder icon in the folder's color. */
export function FolderGlyph({ color, className }: { color: KbLibraryColor | null; className?: string }): JSX.Element {
  return (
    <Folder
      aria-hidden
      className={cn("shrink-0", className)}
      strokeWidth={1.5}
      style={color ? kbColorFolder(color) : { color: "oklch(var(--muted-foreground))", fill: "oklch(var(--muted))" }}
    />
  );
}

/** Label colors in picker order: the ones the user named first, then the rest in palette order. */
export function labelOrder(labels: readonly KbColorLabel[] | undefined): KbLibraryColor[] {
  const named = KB_LIBRARY_COLORS.filter((c) => kbLabelName(c, labels));
  return [...named, ...KB_LIBRARY_COLORS.filter((c) => !named.includes(c))];
}

/**
 * The label picker: the user's names beside the swatches (the color name when
 * a color has no name), a check on the current one, and "No label".
 */
export function labelEntries(
  value: KbLibraryColor | null,
  labels: readonly KbColorLabel[] | undefined,
  onSelect: (color: KbLibraryColor | null) => void
): KbMenuEntry[] {
  return [
    { kind: "heading", label: "Label", hint: "Only you see this." },
    ...labelOrder(labels).map((color): KbMenuEntry => {
      const name = kbLabelName(color, labels);
      return {
        label: name ?? kbColorLabel(color),
        detail: name ? kbColorLabel(color) : undefined,
        swatch: color,
        radio: true,
        checked: value === color,
        onSelect: () => {
          if (value !== color) onSelect(color);
        }
      };
    }),
    {
      label: "No label",
      icon: CircleSlash,
      radio: true,
      checked: value === null,
      onSelect: () => {
        if (value !== null) onSelect(null);
      }
    }
  ];
}
