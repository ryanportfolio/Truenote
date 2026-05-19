import { useState } from "react";
import { cn } from "@/lib/utils";
import type { DocumentListItem } from "@/types/api";
import { PreviewPanel } from "./PreviewPanel";

interface DocumentListProps {
  items: DocumentListItem[];
}

function StatusPill({ status }: { status: string | null }): JSX.Element {
  const s = status ?? "pending";
  const map: Record<string, string> = {
    pending: "bg-secondary text-secondary-foreground",
    parsing: "bg-warning/20 text-warning-foreground",
    ready: "bg-emerald-500/20 text-emerald-900 dark:text-emerald-200",
    failed: "bg-destructive/20 text-destructive"
  };
  return (
    <span className={cn("rounded px-2 py-0.5 text-xs font-medium", map[s] ?? map["pending"])}>
      {s}
    </span>
  );
}

export function DocumentList({ items }: DocumentListProps): JSX.Element {
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        No documents yet. Upload one to get started.
      </div>
    );
  }

  return (
    <>
      <table className="w-full overflow-hidden rounded border border-border text-sm">
        <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Uploaded</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.documentId} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{item.title}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {item.uploadedAt ? new Date(item.uploadedAt).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2">
                <StatusPill status={item.parseStatus} />
              </td>
              <td className="px-3 py-2 text-right">
                {item.versionId && item.parseStatus === "ready" ? (
                  <button
                    onClick={() => setPreviewVersionId(item.versionId)}
                    className="rounded border border-input px-2 py-1 text-xs hover:bg-secondary"
                  >
                    Preview
                  </button>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {previewVersionId ? (
        <PreviewPanel versionId={previewVersionId} onClose={() => setPreviewVersionId(null)} />
      ) : null}
    </>
  );
}
