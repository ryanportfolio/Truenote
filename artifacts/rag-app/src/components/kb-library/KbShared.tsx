import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { Bookmark, Eye, Lock, Quote, StickyNote } from "lucide-react";
import { KB_LIBRARY_COLORS, kbColorChip, kbColorDot, kbColorLabel } from "@/lib/kbLibraryColors";
import { KB_NOTE_MAX } from "@/lib/kbLibrary";
import { cn } from "@/lib/utils";
import type { KbDocumentListItem, KbLibraryColor, KbTag } from "@/types/api";
import { KbDialogActions, KbInlineError } from "./KbDialog";
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

/** Screen reader text for a source's private color. */
export function SourceColorLabel({ color }: { color: KbLibraryColor | null }): JSX.Element | null {
  if (!color) return null;
  return <span className="sr-only">My color: {kbColorLabel(color)}.</span>;
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
      aria-label={`Pin ${doc.title}`}
      title={pinned ? "Remove from My pins" : "Add to My pins"}
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
  onOpen
}: {
  doc: KbDocumentListItem;
  onOpen: () => void;
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
        className="btn-icon h-8 w-8 text-foreground"
      >
        <StickyNote className="h-4 w-4" aria-hidden />
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

/** Views and citations over the last 30 days. Numbers stay quiet; labels are spoken in full. */
export function DocCounts({ doc }: { doc: KbDocumentListItem }): JSX.Element {
  return (
    <span className="hidden items-center gap-3 tabular-nums text-xs text-muted-foreground sm:inline-flex">
      <span className="inline-flex items-center gap-1" title="Opens in the last 30 days">
        <Eye className="h-3.5 w-3.5" aria-hidden />
        <span aria-hidden>{doc.viewCount}</span>
        <span className="sr-only">
          Opened {doc.viewCount} {doc.viewCount === 1 ? "time" : "times"} in the last 30 days.
        </span>
      </span>
      <span className="inline-flex items-center gap-1" title="Answers that cited it in the last 30 days">
        <Quote className="h-3.5 w-3.5" aria-hidden />
        <span aria-hidden>{doc.citationCount}</span>
        <span className="sr-only">
          Cited in {doc.citationCount} {doc.citationCount === 1 ? "answer" : "answers"} in the last 30 days.
        </span>
      </span>
    </span>
  );
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
        maxLength={KB_NOTE_MAX}
        rows={6}
        aria-describedby={helpId}
        placeholder="What do you want to remember about this source?"
        className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
      <div id={helpId} className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          Only you can see this note.
        </span>
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
