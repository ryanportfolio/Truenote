import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/**
 * In-app replacement for window.confirm(). A single dialog lives in the
 * provider; useConfirm() hands components a promise-returning confirm()
 * so the imperative call sites read almost the same:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ message: "…" }))) return;
 *
 * Rendered in our own tokens (card surface, brand/destructive buttons)
 * instead of the browser chrome. Portaled to <body> so it escapes the
 * app-shell's overflow-hidden panes and sits above the topbar (z-30).
 */
export interface ConfirmOptions {
  /** Short dialog heading. Defaults to "Are you sure?". */
  title?: string;
  /** Body text. Plain strings keep their line breaks (whitespace-pre-line). */
  message: ReactNode;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * "danger" paints the confirm button in the destructive palette — use for
   * irreversible actions (delete, revoke sessions). "default" uses brand blue.
   */
  tone?: "default" | "danger";
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Access the confirm() function. Must be called under a <ConfirmProvider>
 * (mounted in AppShell), so it's available to every authenticated page.
 */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error("useConfirm must be used within a ConfirmProvider");
  }
  return confirm;
}

interface PendingConfirm {
  options: ConfirmOptions;
  resolve: (result: boolean) => void;
}

export function ConfirmProvider({
  children
}: {
  children: ReactNode;
}): JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  // Mirror of `pending` for side-effect-free reads inside confirm()/settle()
  // (state updaters must stay pure — resolving a promise there would be a
  // side effect that StrictMode's double-invoke could fire twice).
  const pendingRef = useRef<PendingConfirm | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // Defensive: if a dialog were somehow already open, resolve its awaiter
      // as cancelled before replacing it so no promise hangs forever.
      pendingRef.current?.resolve(false);
      const next: PendingConfirm = { options, resolve };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    pendingRef.current?.resolve(result);
    pendingRef.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <ConfirmDialog
          options={pending.options}
          onCancel={() => settle(false)}
          onConfirm={() => settle(true)}
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  options,
  onConfirm,
  onCancel
}: {
  options: ConfirmOptions;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const {
    title = "Are you sure?",
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    tone = "default"
  } = options;

  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  // Focus the confirm button on open; return focus to the trigger on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Escape cancels; lock body scroll while the dialog is up.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop: warm-ink wash. Clicking outside the panel cancels; mousedown
        * (not click) so a drag that starts inside the panel and ends here
        * doesn't dismiss. */}
      <div
        className="absolute inset-0 bg-foreground/40 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
        aria-hidden
        onMouseDown={onCancel}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
      >
        <h2
          id={titleId}
          className="font-display text-lg font-semibold tracking-tight text-foreground"
        >
          {title}
        </h2>
        <div
          id={descId}
          className="mt-2 whitespace-pre-line text-sm leading-relaxed text-muted-foreground"
        >
          {message}
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn-whisper px-4 py-1.5 text-sm"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={cn(
              "px-4 py-1.5 text-sm",
              tone === "danger"
                ? "btn-base bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : "btn-primary"
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
