import { useId, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { KB_LABEL_NAME_MAX } from "@/lib/kbLibrary";
import { KB_LIBRARY_COLORS, kbColorDot, kbColorLabel, kbLabelName } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbLibraryColor } from "@/types/api";
import { useKbLibraryContext } from "./KbContext";
import { KbInlineError } from "./KbDialog";

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

/** Rename form: one field per color. Saving sends only the names that changed. */
function LabelNamesForm({ onDone }: { onDone: () => void }): JSX.Element {
  const { data, actions } = useKbLibraryContext();
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(KB_LIBRARY_COLORS.map((c) => [c, kbLabelName(c, data.labels) ?? ""]))
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseId = useId();

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    for (const color of KB_LIBRARY_COLORS) {
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

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-2" data-kb-label-form>
      {KB_LIBRARY_COLORS.map((color, i) => (
        <div key={color} className="flex items-center gap-2.5">
          <span aria-hidden className="h-5 w-5 shrink-0 rounded-full border border-foreground/15" style={kbColorDot(color)} />
          <label htmlFor={`${baseId}-${color}`} className="w-14 shrink-0 text-sm font-medium">
            {kbColorLabel(color)}
          </label>
          <input
            id={`${baseId}-${color}`}
            data-autofocus={i === 0 ? true : undefined}
            autoFocus={i === 0}
            value={names[color] ?? ""}
            maxLength={KB_LABEL_NAME_MAX}
            onChange={(e) => setNames((prev) => ({ ...prev, [color]: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onDone();
              }
            }}
            placeholder="Add a name"
            className="min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          />
        </div>
      ))}
      <KbInlineError message={error} />
      <div className="mt-1 flex justify-end gap-2">
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
 * "My labels": each label color the user uses, with the name they gave it.
 * Choosing one filters the list; Edit renames them. Shown as a card beside
 * the list from 1440px and inside Filters below that.
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
  const { data } = useKbLibraryContext();
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
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit label names"
            className="cursor-pointer rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Edit
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 text-sm text-muted-foreground">Only you see these</p>

      {editing ? (
        <div className="mt-3">
          <LabelNamesForm onDone={() => setEditing(false)} />
        </div>
      ) : colors.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Give a source a label from its menu (the three dots on its row). Your labels show here.
        </p>
      ) : (
        <>
          <ul className="mt-3 flex flex-col gap-1">
            {colors.map((color) => {
              const name = kbLabelName(color, data.labels);
              const on = selected.includes(color);
              return (
                <li key={color}>
                  <button
                    type="button"
                    aria-pressed={on}
                    data-kb-label={color}
                    onClick={() => onToggle(color)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-100 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "bg-primary/10" : "hover:bg-muted"
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-6 w-6 shrink-0 rounded-full border border-foreground/15"
                      style={kbColorDot(color)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{kbColorLabel(color)}</span>
                      {name ? <span className="block break-words text-sm text-muted-foreground">{name}</span> : null}
                    </span>
                    {on ? <Check className="h-4 w-4 shrink-0 text-primary" strokeWidth={2.5} aria-hidden /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 border-t border-border pt-3 text-sm text-muted-foreground">
            Choose a label to filter sources.
          </p>
        </>
      )}
    </section>
  );
}
