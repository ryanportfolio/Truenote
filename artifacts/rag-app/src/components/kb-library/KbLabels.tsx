import { useId, useState, type FormEvent } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { KB_LABEL_NAME_MAX } from "@/lib/kbLibrary";
import { KB_LIBRARY_COLORS, kbColorLabel, kbLabelName, kbLabelText } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbLibraryColor } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbInlineError } from "./KbDialog";
import { ColorDot } from "./KbShared";

/** Colors worth listing: the ones on at least one source, named ones, and any still selected as a filter. */
export function usedLabelColors(
  items: { myColor: KbLibraryColor | null }[],
  labels: { color: KbLibraryColor }[] | undefined,
  selected: KbLibraryColor[]
): KbLibraryColor[] {
  return KB_LIBRARY_COLORS.filter(
    (c) => selected.includes(c) || items.some((d) => d.myColor === c) || (labels ?? []).some((l) => l.color === c)
  );
}

/** Edit labels: a pencil over a label tag, drawn for this card. */
function EditGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 12.6V5.2c0-.95.75-1.7 1.7-1.7h7.4l3.2 3.2" />
      <circle cx="7.6" cy="7.6" r="1.25" fill="currentColor" stroke="none" />
      <path d="M3.5 12.6l5.9 5.9" />
      <path d="M17.6 8.2a2 2 0 0 1 2.8 2.8l-7.6 7.6-3.7.9.9-3.7z" />
      <path d="M16.1 9.7l2.8 2.8" />
    </svg>
  );
}

function sourcesLabel(count: number): string {
  return `${count} ${count === 1 ? "source" : "sources"}`;
}

/**
 * Edit mode: one row per label (dot, name, how many sources, delete), plus
 * "New label". Saving sends only the names that changed. Deleting takes the
 * label off its sources and removes the name, right away, in one request.
 * Saving and deleting never overlap: each disables the other until it ends.
 */
function LabelListForm({
  colors,
  onDone,
  onDeleted
}: {
  colors: KbLibraryColor[];
  onDone: () => void;
  /** After a successful delete, so a filter on that label can be turned off. */
  onDeleted: (color: KbLibraryColor) => void;
}): JSX.Element {
  const { data, actions, openDialog } = useKbLibraryContext();
  const confirm = useConfirm();
  // Edited names only; a label made while editing shows its saved name.
  const [names, setNames] = useState<Record<string, string>>({});
  const [deleted, setDeleted] = useState<Set<KbLibraryColor>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();
  const count = (color: KbLibraryColor): number => data.items.filter((d) => d.myColor === color).length;
  // A deleted color stays hidden until it is a label again (named, or on a source).
  const rows = colors.filter((c) => !deleted.has(c) || kbLabelName(c, data.labels) !== null || count(c) > 0);
  const nameOf = (color: KbLibraryColor): string => names[color] ?? kbLabelName(color, data.labels) ?? "";

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    for (const color of rows) {
      if (!(color in names)) continue;
      const result = await actions.setLabelName(color, names[color] ?? "");
      if (!result.ok) {
        setError(result.message);
        setPending(false);
        return;
      }
    }
    setPending(false);
    onDone();
  }

  async function remove(color: KbLibraryColor): Promise<void> {
    const name = kbLabelName(color, data.labels);
    // Labels are shared across programs, so the count here can miss sources elsewhere.
    const ok = await confirm({
      title: name ? `Delete the label "${name}"?` : "Delete this label?",
      message: "It comes off every source that has it, in all your programs. The sources stay in the library.",
      confirmLabel: "Delete label",
      tone: "danger"
    });
    if (!ok || pending) return;
    setPending(true);
    setError(null);
    const result = await actions.deleteLabel(color);
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setDeleted((prev) => new Set(prev).add(color));
    setNames(({ [color]: _gone, ...rest }) => rest);
    onDeleted(color);
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-3" data-kb-label-form>
      {rows.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {rows.map((color, i) => (
            <li key={color} className="flex items-start gap-2.5">
              <ColorDot color={color} className="mt-3 h-3.5 w-3.5" />
              <div className="min-w-0 flex-1">
                <label htmlFor={`${baseId}-${color}`} className="sr-only">
                  {kbColorLabel(color)} label name
                </label>
                <input
                  id={`${baseId}-${color}`}
                  data-autofocus={i === 0 ? true : undefined}
                  autoFocus={i === 0}
                  value={nameOf(color)}
                  maxLength={KB_LABEL_NAME_MAX}
                  onChange={(e) => setNames((prev) => ({ ...prev, [color]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      onDone();
                    }
                  }}
                  placeholder="Name this label"
                  className="w-full rounded-md border border-input bg-card px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                />
                <p className="mt-0.5 text-xs text-muted-foreground">{sourcesLabel(count(color))}</p>
              </div>
              <button
                type="button"
                onClick={() => void remove(color)}
                disabled={pending}
                aria-label={`Delete label ${nameOf(color) || kbLabelText(color, data.labels)}`}
                title="Delete label"
                className="btn-icon mt-0.5 h-8 w-8 shrink-0 hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button
        type="button"
        onClick={() => openDialog({ kind: "label-create", documentId: null })}
        className="btn-whisper justify-center gap-1.5 border-dashed px-3 py-1.5 text-sm"
      >
        <Plus className="h-4 w-4" aria-hidden />
        New label
      </button>
      <KbInlineError message={error} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="btn-whisper px-3 py-1.5 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn-whisper px-3 py-1.5 text-sm font-medium">
          {pending ? "Saving…" : "Save names"}
        </button>
      </div>
    </form>
  );
}

/**
 * "My labels": each label the user has, by name, with how many sources carry
 * it. Choosing one filters the list; Edit renames or deletes them. Shown as a
 * card beside the list from 1280px and inside Filters below that.
 */
export function KbLabels({
  selected,
  onToggle,
  variant
}: {
  selected: KbLibraryColor[];
  onToggle: (color: KbLibraryColor) => void;
  variant: "card" | "popover";
}): JSX.Element {
  const { data, openDialog } = useKbLibraryContext();
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const colors = usedLabelColors(data.items, data.labels, selected);
  const Heading = variant === "card" ? "h2" : "h3";

  return (
    <section
      aria-labelledby={headingId}
      data-kb-labels={variant}
      className={cn(variant === "card" && "rounded-lg border border-border bg-card p-4 shadow-card")}
    >
      <div className="flex items-baseline justify-between gap-3">
        <Heading
          id={headingId}
          className={cn(variant === "card" ? "font-display text-xl font-semibold tracking-tight" : "text-sm font-medium")}
        >
          My labels
        </Heading>
        {!editing && colors.length > 0 ? (
          <span className="group/edit relative -my-1 shrink-0">
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Edit labels"
              className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-primary/30 bg-primary/5 text-primary shadow-card transition-colors duration-100 ease-out hover:border-primary/60 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <EditGlyph />
            </button>
            {/* Instant tooltip (no browser delay), on hover and keyboard focus. */}
            <span
              aria-hidden
              className="pointer-events-none absolute right-0 top-full z-30 mt-1.5 hidden whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs font-medium text-background shadow-panel group-hover/edit:block group-has-[:focus-visible]/edit:block"
            >
              Edit
            </span>
          </span>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3">
          <LabelListForm
            colors={colors}
            onDone={() => setEditing(false)}
            // A filter on a deleted label would hide every source.
            onDeleted={(color) => {
              if (selected.includes(color)) onToggle(color);
            }}
          />
        </div>
      ) : (
        <>
          {colors.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Label a source from its menu (the three dots on its row).
            </p>
          ) : (
            <ul className="mt-3 flex flex-col gap-1.5">
              {colors.map((color) => {
                const name = kbLabelName(color, data.labels);
                const on = selected.includes(color);
                const count = data.items.filter((d) => d.myColor === color).length;
                return (
                  <li key={color}>
                    <button
                      type="button"
                      aria-pressed={on}
                      data-kb-label={color}
                      onClick={() => onToggle(color)}
                      title={on ? "Show all sources" : "Show only sources with this label"}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2.5 rounded-full border px-3 py-1.5 text-left text-sm transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on ? "border-primary/40 bg-primary/10 font-medium" : "border-border bg-card hover:bg-muted"
                      )}
                    >
                      <ColorDot color={color} />
                      <span className={cn("min-w-0 flex-1 break-words", !name && "text-muted-foreground")}>
                        {name ?? (
                          <>
                            No name yet<span className="sr-only"> ({kbColorLabel(color)})</span>
                          </>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                        <span className="sr-only">, </span>
                        {count}
                        <span className="sr-only"> {count === 1 ? "source" : "sources"}</span>
                      </span>
                      {on ? <Check className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} aria-hidden /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            type="button"
            onClick={() => openDialog({ kind: "label-create", documentId: null })}
            className="mt-3 inline-flex cursor-pointer items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            <Plus className="h-4 w-4" aria-hidden />
            New label
          </button>
        </>
      )}
    </section>
  );
}
