import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { getDocumentPreview } from "@/lib/api";
import type { PreviewResponse } from "@/types/api";

interface PreviewPanelProps {
  versionId: string;
  onClose: () => void;
}

export function PreviewPanel({ versionId, onClose }: PreviewPanelProps): JSX.Element {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      role="dialog"
      aria-label="Parsed markdown preview"
      className="fixed right-0 top-14 z-40 flex h-[calc(100vh-3.5rem)] w-[min(640px,90vw)] flex-col border-l border-border bg-card shadow-panel"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex flex-col">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Preview</span>
          <span className="text-sm font-medium">{data?.title ?? "Parsed markdown"}</span>
        </div>
        <button
          onClick={onClose}
          aria-label="Close preview"
          className="btn-icon"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-4">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : data.markdown === null ? (
          <p className="text-sm text-muted-foreground">
            No parsed markdown yet. Status: {data.parseStatus ?? "unknown"}.
          </p>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
            {data.markdown}
          </pre>
        )}
      </div>
    </aside>
  );
}
