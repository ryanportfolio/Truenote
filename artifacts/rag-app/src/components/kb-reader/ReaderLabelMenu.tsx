import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent
} from "react";
import { createPortal } from "react-dom";
import { Check, CircleSlash, Pencil, Tag } from "lucide-react";
import { KB_LIBRARY_COLORS, kbColorDot, kbColorLabel } from "@/lib/kbLibraryColors";
import { cn } from "@/lib/utils";
import type { KbColorLabel, KbLibraryColor } from "@/types/api";

const LABEL_NAME_MAX = 40;

export type SaveLabelName = (color: KbLibraryColor, name: string | null) => Promise<string | null>;

/** "Read before quoting fees" for a named color, else null. */
export function labelName(labels: KbColorLabel[], color: KbLibraryColor): string | null {
  return labels.find((label) => label.color === color)?.name ?? null;
}

function Swatch({ color, className }: { color: KbLibraryColor; className?: string }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-3.5 w-3.5 shrink-0 rounded-full border border-foreground/15", className)}
      style={kbColorDot(color)}
    />
  );
}

/**
 * "Color label" button for the reader header. Opens a menu of the user's
 * labels: every color with the name the user gave it beside the swatch, a
 * check on the current one, and "No label". With a label chosen, the menu
 * can also rename it (names are private and shared with Sources). Arrow
 * keys, Home and End move between items; Escape closes and returns focus.
 */
export function ReaderLabelMenu({
  value,
  labels,
  onSelect,
  onRename
}: {
  value: KbLibraryColor | null;
  labels: KbColorLabel[];
  onSelect: (color: KbLibraryColor | null) => void;
  onRename: SaveLabelName;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"pick" | "rename">("pick");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const titleId = useId();
  const currentName = value ? labelName(labels, value) : null;

  function close(returnFocus = true): void {
    setOpen(false);
    setMode("pick");
    if (returnFocus) requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function place(): void {
    const button = buttonRef.current;
    const panel = panelRef.current;
    if (!button || !panel) return;
    const rect = button.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
    setPosition((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, mode]);

  // Focus the current choice (or the first item) once the menu is placed.
  useEffect(() => {
    if (!open || !position || mode !== "pick") return;
    const items = menuItems();
    const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? items[0])?.focus({ preventScroll: true });
  }, [open, position === null, mode]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      close(false);
    }
    function onScroll(event: Event): void {
      if (panelRef.current?.contains(event.target as Node)) return;
      place();
    }
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  function menuItems(): HTMLElement[] {
    return Array.from(panelRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items[items.length - 1];
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    } else if (event.key === "Tab") {
      close(false);
      return;
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  function choose(color: KbLibraryColor | null): void {
    if (color !== value) onSelect(color);
    close();
  }


  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        data-kb-reader-label
        title="A color label only you see"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className="btn-whisper min-w-0 max-w-full gap-2 px-3.5 py-2 sm:px-4"
      >
        <Tag className="h-4 w-4 shrink-0" aria-hidden />
        {value ? (
          <>
            <span className="shrink-0">Color label:</span>
            <Swatch color={value} />
            <span className="min-w-0 truncate sm:max-w-[16rem]">{currentName ?? kbColorLabel(value)}</span>
          </>
        ) : (
          "Color label"
        )}
      </button>
      {open
        ? createPortal(
            <div
              ref={panelRef}
              data-kb-reader-label-menu
              className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-lg border border-border bg-card p-1.5 text-card-foreground shadow-panel"
              style={position ?? { top: -9999, left: -9999, visibility: "hidden" }}
            >
              {mode === "pick" ? (
                <div id={menuId} role="menu" aria-labelledby={titleId} onKeyDown={onMenuKeyDown}>
                  <div className="px-2.5 pb-1.5 pt-1">
                    <p id={titleId} className="text-sm font-medium">
                      Color label
                    </p>
                    <p className="text-xs text-muted-foreground">Only you see your labels.</p>
                  </div>
                  {KB_LIBRARY_COLORS.map((color) => {
                    const name = labelName(labels, color);
                    const checked = value === color;
                    return (
                      <button
                        key={color}
                        type="button"
                        role="menuitemradio"
                        aria-checked={checked}
                        tabIndex={-1}
                        onClick={() => choose(color)}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Swatch color={color} />
                        <span className="min-w-0 flex-1">
                          {name ? (
                            <>
                              <span className="block truncate">{name}</span>
                              <span className="block text-xs text-muted-foreground">{kbColorLabel(color)}</span>
                            </>
                          ) : (
                            kbColorLabel(color)
                          )}
                        </span>
                        <Check className={cn("h-4 w-4 shrink-0 text-primary", !checked && "invisible")} aria-hidden />
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={value === null}
                    tabIndex={-1}
                    onClick={() => choose(null)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CircleSlash className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1">No label</span>
                    <Check className={cn("h-4 w-4 shrink-0 text-primary", value !== null && "invisible")} aria-hidden />
                  </button>
                  {value ? (
                    <>
                      <div role="separator" className="my-1 h-px bg-border" />
                      <button
                        type="button"
                        role="menuitem"
                        tabIndex={-1}
                        onClick={() => setMode("rename")}
                        className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {currentName ? `Rename ${kbColorLabel(value)}` : `Name ${kbColorLabel(value)}`}
                      </button>
                    </>
                  ) : null}
                </div>
              ) : value ? (
                <RenameForm
                  color={value}
                  initialName={currentName}
                  onCancel={() => close()}
                  onSave={async (name) => {
                    const error = await onRename(value, name);
                    if (!error) close();
                    return error;
                  }}
                />
              ) : null}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function RenameForm({
  color,
  initialName,
  onCancel,
  onSave
}: {
  color: KbLibraryColor;
  initialName: string | null;
  onCancel: () => void;
  onSave: (name: string | null) => Promise<string | null>;
}): JSX.Element {
  const [value, setValue] = useState(initialName ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = useId();
  const helpId = useId();

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const trimmed = value.trim();
    const message = await onSave(trimmed ? trimmed : null);
    setPending(false);
    if (message) setError(message);
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      className="flex flex-col gap-2 p-2"
    >
      <label htmlFor={fieldId} className="flex items-center gap-2 text-sm font-medium">
        <Swatch color={color} />
        Name for {kbColorLabel(color)}
      </label>
      <input
        id={fieldId}
        autoFocus
        value={value}
        maxLength={LABEL_NAME_MAX}
        onChange={(event) => setValue(event.target.value)}
        aria-describedby={helpId}
        placeholder="For example, Read before quoting fees"
        className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
      />
      <p id={helpId} className="text-xs text-muted-foreground">
        Only you see this name. Leave it empty to use the color name.
      </p>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-whisper px-3 py-1.5 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn-primary px-3 py-1.5 text-sm">
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
