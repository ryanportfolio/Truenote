import { useEffect, useRef, useState } from "react";
import { Bookmark, Lock, Pencil, StickyNote } from "lucide-react";
import { listKbDocuments, setKbNote, setKbPin } from "@/lib/api";
import { RelativeTime } from "@/components/RelativeTime";
import { cn } from "@/lib/utils";
import type { KbSourceUserState } from "@/types/api";
import { NoteForm } from "./KbShared";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; item: KbSourceUserState }
  | { status: "unavailable" };

/**
 * Pin toggle and private note for the document reader. The reader response
 * carries no personal state, so this reads the user's pin and note from the
 * library list (same program scope) and writes through the pin and note
 * endpoints. Renders nothing when the list does not include the document.
 */
export function KbDocPersonalBar({ documentId }: { documentId: string }): JSX.Element | null {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [editing, setEditing] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const pinVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setEditing(false);
    listKbDocuments()
      .then((response) => {
        if (cancelled) return;
        const doc = response.items.find((d) => d.documentId === documentId);
        setState(
          doc
            ? {
                status: "ready",
                item: {
                  documentId,
                  pinnedAt: doc.pinnedAt,
                  note: doc.note,
                  noteUpdatedAt: doc.noteUpdatedAt
                }
              }
            : { status: "unavailable" }
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (state.status === "unavailable") return null;
  if (state.status === "loading") {
    return (
      <div className="mt-3 flex gap-2" aria-hidden>
        <div className="skeleton h-7 w-20 rounded-full" />
        <div className="skeleton h-7 w-40 rounded-full" />
      </div>
    );
  }

  const item = state.item;
  const pinned = item.pinnedAt !== null;

  async function togglePin(): Promise<void> {
    const before = item;
    const version = ++pinVersion.current;
    const next = !pinned;
    setPinError(null);
    setState({ status: "ready", item: { ...before, pinnedAt: next ? new Date().toISOString() : null } });
    try {
      const saved = await setKbPin(documentId, next);
      if (version === pinVersion.current) setState({ status: "ready", item: saved });
    } catch (err) {
      if (version === pinVersion.current) setState({ status: "ready", item: before });
      setPinError(err instanceof Error ? err.message : "The pin didn't save. Try again.");
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
      {pinError ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {pinError}
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
                    // Keep the local pin: a pin toggle may still be in flight.
                    setState((prev) =>
                      prev.status === "ready"
                        ? { status: "ready", item: { ...saved, pinnedAt: prev.item.pinnedAt } }
                        : prev
                    );
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
