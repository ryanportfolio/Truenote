import { useEffect, useRef } from "react";
import { Link } from "wouter";
import { BookOpen, X } from "lucide-react";
import type { Source } from "@/types/api";

interface CitationPanelProps {
  source: Source;
  onClose: () => void;
  /** Manager-and-above: show the raw chunk id. */
  showDebug: boolean;
}

export function CitationPanel({ source, onClose, showDebug }: CitationPanelProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  // Move focus into the panel on open and hand it back on close, so a
  // keyboard CSR lands on Close (Esc also works) and returns to the chip.
  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "Escape") onClose();
  }

  return (
    <aside
      role="dialog"
      aria-label={`Citation: ${source.doc_title}`}
      onKeyDown={onKeyDown}
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(560px,90vw)] flex-col border-l border-border bg-card shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Source</span>
          <span className="text-sm font-medium">{source.doc_title}</span>
          {showDebug ? (
            <span className="text-xs text-muted-foreground">chunk_id: {source.chunk_id}</span>
          ) : null}
        </div>
        <button
          ref={closeRef}
          onClick={onClose}
          aria-label="Close citation"
          className="btn-icon"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        {/* The excerpt is the receipt — it gets its own inset surface and a
         * mono face so it reads as quoted source, not UI chrome. */}
        <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
          {source.excerpt}
        </pre>
        {source.doc_id ? (
          // The excerpt is the receipt; this is the full ledger. Navigating
          // unmounts the panel with the page, which is the right cleanup.
          <Link
            href={`/kb/${source.doc_id}`}
            className="btn-whisper mt-3 inline-flex gap-1.5 px-3 py-1.5 text-sm"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            Read the full document
          </Link>
        ) : null}
      </div>
    </aside>
  );
}
