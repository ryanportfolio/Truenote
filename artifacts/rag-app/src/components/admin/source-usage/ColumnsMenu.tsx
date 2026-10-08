import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Columns3 } from "lucide-react";
import { SOURCE_COLUMN_OPTIONS, type SourceColumn } from "@/lib/sourceUsage";

interface ColumnsMenuProps {
  columns: readonly SourceColumn[];
  onChange: (columns: SourceColumn[]) => void;
}

/**
 * "Columns" disclosure for the sources table: one checkbox per optional
 * column. Source and Citations always show. Escape or an outside press
 * closes it; Escape returns focus to the trigger.
 */
export function ColumnsMenu({ columns, onChange }: ColumnsMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    function onPointerDown(event: PointerEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function toggle(key: SourceColumn, on: boolean): void {
    const next = new Set(columns);
    if (on) next.add(key);
    else next.delete(key);
    onChange(SOURCE_COLUMN_OPTIONS.map((option) => option.key).filter((k) => next.has(k)));
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1 text-xs"
      >
        <Columns3 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        Columns
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div
          id={panelId}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
          className="absolute right-0 z-30 mt-2 w-72 rounded-lg border border-border bg-card p-3 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Show columns
            </legend>
            <p className="text-xs text-muted-foreground">Source and Citations always show.</p>
            {SOURCE_COLUMN_OPTIONS.map((option) => (
              <label
                key={option.key}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={columns.includes(option.key)}
                  onChange={(event) => toggle(option.key, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.hint}</span>
                </span>
              </label>
            ))}
            <p className="mt-1 text-xs text-muted-foreground">Saved for your account on this browser.</p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
