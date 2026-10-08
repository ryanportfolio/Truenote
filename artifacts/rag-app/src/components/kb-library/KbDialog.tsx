import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog for the Sources page forms (note, categories, tags). Same
 * surface and motion as ConfirmDialog; Escape and the backdrop close it, Tab
 * stays inside, and focus returns to the opener. Escape is handled on the
 * panel rather than the document so a ConfirmDialog stacked on top closes
 * alone.
 */
export function KbDialog({
  title,
  description,
  onClose,
  children,
  wide = false
}: {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const preferred = panel?.querySelector<HTMLElement>("[data-autofocus]");
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? first ?? panel)?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null
    );
    if (focusables.length === 0) return;
    const first = focusables[0] as HTMLElement;
    const last = focusables[focusables.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-foreground/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        aria-hidden
        onMouseDown={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "relative flex max-h-[calc(100vh_-_2rem)] w-full flex-col rounded-lg border border-border bg-card shadow-panel focus:outline-none motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150",
          wide ? "max-w-lg" : "max-w-md"
        )}
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-5">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="font-display text-lg font-semibold tracking-tight text-foreground"
            >
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" onClick={onClose} className="btn-icon -mr-2 shrink-0" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-6 pb-5 pt-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/** Footer row for dialog forms: destructive action on the left, the rest on the right. */
export function KbDialogActions({
  start,
  children
}: {
  start?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
      <div>{start}</div>
      <div className="flex flex-wrap justify-end gap-2">{children}</div>
    </div>
  );
}

export function KbInlineError({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </p>
  );
}
