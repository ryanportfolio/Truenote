import { useRef, useState } from "react";
import { Bookmark, CircleSlash, Lock, Palette, Pencil, StickyNote } from "lucide-react";
import { setKbNote, setKbPin, setKbSourceColor } from "@/lib/api";
import { kbColorLabel } from "@/lib/kbLibraryColors";
import { RelativeTime } from "@/components/RelativeTime";
import { cn } from "@/lib/utils";
import type { KbDocumentResponse, KbLibraryColor } from "@/types/api";
import { KbMenu } from "./KbMenu";
import { ColorDot, NoteForm } from "./KbShared";

type Personal = Pick<KbDocumentResponse, "pinnedAt" | "note" | "noteUpdatedAt" | "myColor">;

/**
 * Pin toggle, private color and private note for the document reader. The
 * reader response carries the user's state; changes write through the pin,
 * color and note endpoints. Each save merges only its own fields, so a pin,
 * color and note change in flight at once never undo each other.
 */
export function KbDocPersonalBar({
  documentId,
  initial
}: {
  documentId: string;
  initial: Personal;
}): JSX.Element {
  const [item, setItem] = useState<Personal>(() => ({
    pinnedAt: initial.pinnedAt ?? null,
    note: initial.note ?? null,
    noteUpdatedAt: initial.noteUpdatedAt ?? null,
    myColor: initial.myColor ?? null
  }));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const pinVersion = useRef(0);
  const colorVersion = useRef(0);
  const pinned = item.pinnedAt !== null;

  async function togglePin(): Promise<void> {
    const before = item.pinnedAt;
    const version = ++pinVersion.current;
    const next = !pinned;
    setError(null);
    setItem((prev) => ({ ...prev, pinnedAt: next ? new Date().toISOString() : null }));
    try {
      const saved = await setKbPin(documentId, next);
      if (version === pinVersion.current) setItem((prev) => ({ ...prev, pinnedAt: saved.pinnedAt }));
    } catch (err) {
      if (version === pinVersion.current) setItem((prev) => ({ ...prev, pinnedAt: before }));
      setError(err instanceof Error ? err.message : "The pin didn't save. Try again.");
    }
  }

  async function setColor(color: KbLibraryColor | null): Promise<void> {
    if (color === item.myColor) return;
    const before = item.myColor;
    const version = ++colorVersion.current;
    setError(null);
    setItem((prev) => ({ ...prev, myColor: color }));
    try {
      const saved = await setKbSourceColor(documentId, color);
      if (version === colorVersion.current) setItem((prev) => ({ ...prev, myColor: saved.color }));
    } catch (err) {
      if (version === colorVersion.current) setItem((prev) => ({ ...prev, myColor: before }));
      setError(err instanceof Error ? err.message : "The color didn't save. Try again.");
    }
  }

  function stopEditing(): void {
    setEditing(false);
    requestAnimationFrame(() => editButtonRef.current?.focus());
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void togglePin()}
          title={pinned ? "Remove from My pins on Sources" : "Keep it in My pins on Sources"}
          className={cn(
            "btn-whisper gap-1.5 px-3 py-1 text-xs",
            pinned && "text-primary"
          )}
        >
          <Bookmark className="h-3.5 w-3.5" fill={pinned ? "currentColor" : "none"} aria-hidden />
          {pinned ? "Pinned" : "Pin"}
        </button>
        <KbMenu
          label={item.myColor ? `My color: ${kbColorLabel(item.myColor)}` : "My color"}
          title="Mark this source with a color only you see"
          buttonClassName="btn-whisper gap-1.5 px-3 py-1 text-xs"
          items={[
            {
              kind: "swatches",
              label: "My color",
              hint: "Only you see it, here and on Sources.",
              value: item.myColor,
              onSelect: (color) => void setColor(color)
            },
            {
              label: "No color",
              icon: CircleSlash,
              disabled: item.myColor === null,
              onSelect: () => void setColor(null)
            }
          ]}
        >
          {item.myColor ? (
            <>
              <ColorDot color={item.myColor} />
              {kbColorLabel(item.myColor)}
            </>
          ) : (
            <>
              <Palette className="h-3.5 w-3.5" aria-hidden />
              My color
            </>
          )}
        </KbMenu>
        {!item.note && !editing ? (
          <button
            ref={editButtonRef}
            type="button"
            onClick={() => setEditing(true)}
            className="btn-whisper gap-1.5 px-3 py-1 text-xs"
          >
            <StickyNote className="h-3.5 w-3.5" aria-hidden />
            Add a private note
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {item.note || editing ? (
        <section
          aria-label="My note"
          className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2.5"
        >
          <div className="flex items-center justify-between gap-2">
            <h2 className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <StickyNote className="h-3.5 w-3.5" aria-hidden />
              My note
            </h2>
            {!editing ? (
              <button
                ref={editButtonRef}
                type="button"
                onClick={() => setEditing(true)}
                className="btn-icon gap-1 px-2 text-xs"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
                Edit
              </button>
            ) : null}
          </div>
          {editing ? (
            <div className="mt-2">
              <NoteForm
                initialNote={item.note}
                autoFocus
                onCancel={stopEditing}
                onSave={async (note) => {
                  try {
                    const saved = await setKbNote(documentId, note);
                    // Take only the note: a pin or color change may still be in flight.
                    setItem((prev) => ({ ...prev, note: saved.note, noteUpdatedAt: saved.noteUpdatedAt }));
                    stopEditing();
                    return { ok: true };
                  } catch (err) {
                    return {
                      ok: false,
                      message: err instanceof Error ? err.message : "The note didn't save. Try again."
                    };
                  }
                }}
              />
            </div>
          ) : item.note ? (
            <>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.note}</p>
              <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" aria-hidden />
                Only you can see this note.
                {item.noteUpdatedAt ? (
                  <>
                    {" "}
                    Updated <RelativeTime iso={item.noteUpdatedAt} />.
                  </>
                ) : null}
              </p>
            </>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
