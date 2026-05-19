import { useState } from "react";
import { cn } from "@/lib/utils";
import { deleteDocument } from "@/lib/api";
import type { DocumentListItem } from "@/types/api";
import { PreviewPanel } from "./PreviewPanel";

interface DocumentListProps {
  items: DocumentListItem[];
  /** Called after a successful delete so the parent can refetch. */
  onDeleted?: () => void;
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

export function DocumentList({ items, onDeleted }: DocumentListProps): JSX.Element {
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  // Per-document delete state — keyed by documentId so we can disable just
  // the row being deleted (instead of blocking the whole table).
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete(item: DocumentListItem): Promise<void> {
    // Browser-native confirm — good enough for Phase 1, no modal lib needed.
    // Phase 2 may swap in a styled confirmation dialog.
    const ok = window.confirm(
      `Delete "${item.title}"? This removes the document, all its versions, and all its chunks. Citations in past chats may stop resolving.`
    );
    if (!ok) return;
    setDeleteError(null);
    setDeletingId(item.documentId);
    try {
      await deleteDocument(item.documentId);
      onDeleted?.();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete document");
    } finally {
      setDeletingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="rounded border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        No documents yet. Upload one to get started.
      </div>
    );
  }

  return (
    <>
      {deleteError ? (
        <p className="text-sm text-destructive">{deleteError}</p>
      ) : null}
      <table className="w-full overflow-hidden rounded border border-border text-sm">
        <thead className="bg-secondary/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Title</th>
            <th className="px-3 py-2">Uploaded</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isDeleting = deletingId === item.documentId;
            return (
              <tr key={item.documentId} className="border-t border-border">
                <td className="px-3 py-2 font-medium">{item.title}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {item.uploadedAt ? new Date(item.uploadedAt).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={item.parseStatus} />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex justify-end gap-2">
                    {item.versionId && item.parseStatus === "ready" ? (
                      <button
                        onClick={() => setPreviewVersionId(item.versionId)}
                        disabled={isDeleting}
                        className="rounded border border-input px-2 py-1 text-xs hover:bg-secondary disabled:opacity-50"
                      >
                        Preview
                      </button>
                    ) : null}
                    <button
                      onClick={() => void handleDelete(item)}
                      disabled={isDeleting}
                      className="rounded border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {previewVersionId ? (
        <PreviewPanel versionId={previewVersionId} onClose={() => setPreviewVersionId(null)} />
      ) : null}
    </>
  );
}
