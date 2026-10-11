import { useEffect, useRef } from "react";
import { BookOpen, X } from "lucide-react";
import { citationDocumentHref, citationLinkKind } from "@/lib/citationLinks";
import { cn } from "@/lib/utils";
import type { Source } from "@/types/api";
import { AppLink, useInMiniWindow } from "./MiniWindow";

interface CitationPanelProps {
  source: Source;
  queryLogId: string | null;
  onClose: () => void;
  /** Manager-and-above: show the raw chunk id. */
  showDebug: boolean;
}

export function CitationPanel({ source, queryLogId, onClose, showDebug }: CitationPanelProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const inMiniWindow = useInMiniWindow();

  // Move focus into the panel on open and hand it back on close, so a
  // keyboard CSR lands on Close (Esc also works) and returns to the chip.
  // The panel's own document: the mini window has a separate one.
  useEffect(() => {
    const active = (closeRef.current?.ownerDocument ?? document).activeElement;
    // Duck-typed: a node from the mini window fails `instanceof HTMLElement`.
    restoreRef.current = active && "focus" in active ? (active as HTMLElement) : null;
    closeRef.current?.focus();
    return () => restoreRef.current?.focus();
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === "Escape") onClose();
    // In the mini window the panel covers everything else, so Tab cycles
    // inside it instead of reaching the hidden composer.
    if (event.key === "Tab" && inMiniWindow) {
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = event.currentTarget.ownerDocument.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  const documentHref = citationDocumentHref(source, queryLogId);
  const linkKind = citationLinkKind(source);

  return (
    <aside
      role="dialog"
      aria-modal={inMiniWindow || undefined}
      aria-label={`Citation: ${source.doc_title}`}
      onKeyDown={onKeyDown}
      className={cn(
        "fixed right-0 z-40 flex flex-col bg-card motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-right-4 motion-safe:duration-240 motion-safe:ease-out-quart",
        // The mini window is too narrow for a side panel: the passage
        // covers the whole window until Close or Esc.
        inMiniWindow
          ? "inset-y-0 w-full"
          : "top-14 h-[calc(100vh-3.5rem)] w-[min(560px,90vw)] border-l border-border shadow-panel"
      )}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Source passage</span>
          <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
            {source.doc_title}
            {source.version_number ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                Version {source.version_number}
              </span>
            ) : null}
            {source.superseded ? (
              <span className="rounded-full bg-warning/20 px-2 py-0.5 text-[11px] font-medium text-foreground">
                Updated since
              </span>
            ) : null}
          </span>
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
        {source.superseded ? (
          // This exact excerpt is the CSR's durable receipt of what they were
          // shown, but the document has since been replaced. Warn plainly so
          // they don't re-quote superseded content on a later call.
          <p className="mt-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            This document has been updated since this answer. The excerpt above is
            what you were shown at the time — check the current version before
            relying on it.
          </p>
        ) : null}
        {documentHref ? (
          // The excerpt is the receipt; this is the full ledger. Navigating
          // unmounts the panel with the page, which is the right cleanup.
          <AppLink
            href={documentHref}
            className="btn-whisper mt-3 inline-flex gap-1.5 px-3 py-1.5 text-sm"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
            {linkKind === "passage"
              ? "Open cited passage"
              : linkKind === "version"
                ? "Open cited version"
                : "Open current document"}
          </AppLink>
        ) : null}
        {documentHref && linkKind === "version" ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            The cited version is preserved. This source has no direct text location,
            which can happen for evidence described from an image.
          </p>
        ) : null}
        {documentHref && linkKind === "current" ? (
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            This answer does not have a version-pinned receipt. The link opens the
            document&apos;s current version.
          </p>
        ) : null}
      </div>
    </aside>
  );
}
