import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { activateDocument, getDocumentPreview } from "@/lib/api";
import type { PreviewResponse } from "@/types/api";

interface PreviewPanelProps {
  versionId: string;
  /** Whether this version is already live. When false, the panel offers approval. */
  isActive: boolean;
  /** Called after the version is approved/published. */
  onApproved: () => void;
  onClose: () => void;
}

export function PreviewPanel({
  versionId,
  isActive,
  onApproved,
  onClose
}: PreviewPanelProps): JSX.Element {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  async function handleApprove(): Promise<void> {
    setApproveError(null);
    setApproving(true);
    try {
      await activateDocument(versionId);
      onApproved();
    } catch (err) {
      setApproveError(err instanceof Error ? err.message : "Failed to publish");
      setApproving(false);
    }
  }
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Same keyboard contract as CitationPanel: focus lands on Close when the
  // panel opens and returns to the opener (the Preview button) on close.
  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  // Close when a pointer press lands outside the panel. Registered after
  // mount, so the click that opened the panel never triggers it.
  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") onClose();
  }

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getDocumentPreview(versionId)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [versionId]);

  return (
    <aside
      ref={panelRef}
      role="dialog"
      aria-label="Parsed text"
      onKeyDown={onKeyDown}
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(640px,90vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Parsed text</span>
          <span className="text-sm font-medium">{data?.title ?? "Document"}</span>
        </div>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close preview"
          className="btn-icon"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : !data ? (
          <div role="status">
            <div className="skeleton h-3.5 w-full" />
            <div className="skeleton mt-2 h-3.5 w-5/6" />
            <div className="skeleton mt-2 h-3.5 w-full" />
            <div className="skeleton mt-2 h-3.5 w-2/3" />
            <span className="sr-only">Loading preview…</span>
          </div>
        ) : data.markdown === null ? (
          <p className="text-sm text-muted-foreground">
            The parsed text is not ready yet. Status: {data.parseStatus ?? "unknown"}.
          </p>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
            {data.markdown}
          </pre>
        )}
      </div>
      {/* Approval gate. A parsed version is not retrievable until a manager+
        * approves it here — controlled, human-approved ingestion. */}
      <footer className="border-t border-border px-4 py-3">
        {isActive ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="h-4 w-4" aria-hidden />
            Published — live in the knowledge base.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {approveError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {approveError}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Review the parsed text, then publish to make it answerable.
              </p>
              <button
                onClick={() => void handleApprove()}
                disabled={approving || data?.markdown === null}
                className="shrink-0 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors duration-100 ease-out hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {approving ? "Publishing…" : "Approve & publish"}
              </button>
            </div>
          </div>
        )}
      </footer>
    </aside>
  );
}
