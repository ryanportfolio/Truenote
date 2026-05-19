import { X } from "lucide-react";
import type { Source } from "@/types/api";

interface CitationPanelProps {
  source: Source;
  onClose: () => void;
}

export function CitationPanel({ source, onClose }: CitationPanelProps): JSX.Element {
  return (
    <aside
      role="dialog"
      aria-label={`Citation: ${source.doc_title}`}
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(560px,90vw)] flex-col border-l border-border bg-card shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Source</span>
          <span className="text-sm font-medium">{source.doc_title}</span>
          <span className="text-[10px] text-muted-foreground">chunk_id: {source.chunk_id}</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close citation"
          className="rounded p-1 hover:bg-secondary"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">
          {source.excerpt}
        </pre>
      </div>
    </aside>
  );
}
