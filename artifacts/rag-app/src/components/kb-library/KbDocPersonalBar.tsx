import { useRef, useState, type RefObject } from "react";
import { Bookmark, Lock, NotebookPen, Palette, Pencil } from "lucide-react";
import { setKbNote, setKbPin, setKbSourceColor } from "@/lib/api";
import { applyUserState } from "@/lib/kbLibrary";
import { patchKbLibraryCache } from "@/lib/kbLibraryCache";
import { kbColorLabel } from "@/lib/kbLibraryColors";
import { RelativeTime } from "@/components/RelativeTime";
import { cn } from "@/lib/utils";
import type { KbDocumentResponse, KbLibraryColor } from "@/types/api";
import { KbMenu } from "./KbMenu";
import { ColorDot, NoteForm, myColorEntries } from "./KbShared";
import type { ActionResult } from "./useKbLibrary";

type Personal = Pick<KbDocumentResponse, "pinnedAt" | "note" | "noteUpdatedAt" | "myColor">;

export interface KbDocPersonal {
  item: Personal;
  error: string | null;
  editing: boolean;
  startEditing: () => void;
  stopEditing: () => void;
  editButtonRef: RefObject<HTMLButtonElement>;
  togglePin: () => Promise<void>;
  setColor: (color: KbLibraryColor | null) => Promise<void>;
  saveNote: (note: string) => Promise<ActionResult>;
}

/**
 * Pin, private color and private note state for the document reader. The
 * reader response carries the user's state; changes write through the pin,
 * color and note endpoints. Each save merges only its own fields, so a pin,
 * color and note change in flight at once never undo each other. Saved
 * state also goes into the shared library cache, so Sources shows it on
 * the way back.
 */
export function useKbDocPersonal(documentId: string, initial: Personal): KbDocPersonal {
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

  async function togglePin(): Promise<void> {
    const before = item.pinnedAt;
    const version = ++pinVersion.current;
    const next = item.pinnedAt === null;
    setError(null);
    setItem((prev) => ({ ...prev, pinnedAt: next ? new Date().toISOString() : null }));
    try {
      const saved = await setKbPin(documentId, next);
      patchKbLibraryCache((d) => applyUserState(d, saved));
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
      patchKbLibraryCache((d) => applyUserState(d, saved));
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

  async function saveNote(note: string): Promise<ActionResult> {
    try {
      const saved = await setKbNote(documentId, note);
      patchKbLibraryCache((d) => applyUserState(d, saved));
      // Take only the note: a pin or color change may still be in flight.
      setItem((prev) => ({ ...prev, note: saved.note, noteUpdatedAt: saved.noteUpdatedAt }));
      stopEditing();
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "The note didn't save. Try again." };
    }
  }

  return {
    item,
    error,
    editing,
    startEditing: () => setEditing(true),
    stopEditing,
    editButtonRef,
    togglePin,
    setColor,
    saveNote
  };
}

/** Labeled Pin and Color buttons, plus "Add note" while the source has no note. */
export function KbDocPersonalActions({ personal }: { personal: KbDocPersonal }): JSX.Element {
  const { item } = personal;
  const pinned = item.pinnedAt !== null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-pressed={pinned}
        onClick={() => void personal.togglePin()}
        title={pinned ? "Remove from My pins on Sources" : "Keep it in My pins on Sources"}
        className={cn("btn-whisper gap-1.5 px-3 py-1 text-xs", pinned && "text-primary")}
      >
        <Bookmark className="h-3.5 w-3.5" fill={pinned ? "currentColor" : "none"} aria-hidden />
        {pinned ? "Pinned" : "Pin"}
      </button>
      <KbMenu
        label={item.myColor ? `Color: ${kbColorLabel(item.myColor)}` : "Color"}
        title="Mark this source with a color only you see"
        buttonClassName="btn-whisper gap-1.5 px-3 py-1 text-xs"
        items={myColorEntries(item.myColor, (color) => void personal.setColor(color))}
      >
        {item.myColor ? (
          <>
            <ColorDot color={item.myColor} />
            Color: {kbColorLabel(item.myColor)}
          </>
        ) : (
          <>
            <Palette className="h-3.5 w-3.5" aria-hidden />
            Color
          </>
        )}
      </KbMenu>
      {!item.note && !personal.editing ? (
        <button
          ref={personal.editButtonRef}
          type="button"
          onClick={personal.startEditing}
          className="btn-whisper gap-1.5 px-3 py-1 text-xs"
        >
          <NotebookPen className="h-3.5 w-3.5" aria-hidden />
          Add note
        </button>
      ) : null}
    </div>
  );
}

/** Save errors for the personal controls, in the quiet-alert recipe. */
export function KbDocPersonalError({ personal }: { personal: KbDocPersonal }): JSX.Element | null {
  if (!personal.error) return null;
  return (
    <p
      role="alert"
      className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {personal.error}
    </p>
  );
}

/** The private note card at the top of the reading surface: view, or edit in place. */
export function KbDocNoteCard({ personal, className }: { personal: KbDocPersonal; className?: string }): JSX.Element | null {
  const { item, editing } = personal;
  if (!item.note && !editing) return null;
  return (
    <section
      aria-label="My note"
      data-kb-note-card
      className={cn("rounded-lg border border-border bg-muted/40 px-4 py-3", className)}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-1.5 text-sm font-medium">
          <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          My note
        </h2>
        {!editing ? (
          <button
            ref={personal.editButtonRef}
            type="button"
            onClick={personal.startEditing}
            className="btn-icon gap-1 px-2 text-xs"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Edit
          </button>
        ) : null}
      </div>
      {editing ? (
        <div className="mt-2">
          <NoteForm initialNote={item.note} autoFocus onCancel={personal.stopEditing} onSave={personal.saveNote} />
        </div>
      ) : item.note ? (
        <>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-relaxed">{item.note}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            <span>Only you can see this note.</span>
            {item.noteUpdatedAt ? (
              <span>
                {" "}
                Updated <RelativeTime iso={item.noteUpdatedAt} />.
              </span>
            ) : null}
          </p>
        </>
      ) : null}
    </section>
  );
}
