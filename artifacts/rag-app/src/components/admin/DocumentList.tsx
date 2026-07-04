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
    pending: "bg-muted text-muted-foreground",
    parsing: "bg-warning/20 text-warning-foreground",
    ready: "bg-success/15 text-success",
    failed: "bg-destructive/15 text-destructive"
  };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", map[s] ?? map["pending"])}>
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
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
        No documents yet. Upload one to get started.
      </div>
    );
  }

  return (
    <>
      {deleteError ? (
        <p className="text-sm text-destructive">{deleteError}</p>
      ) : null}
      {/* Cohere table language: header carried by type + rule, not fill;
        * rows separated by horizontal hairlines only. */}
      <table className="w-full overflow-hidden rounded-lg border border-border bg-card text-sm shadow-card">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Uploaded</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
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
                        className="btn-whisper px-2.5 py-1 text-xs"
                      >
                        Preview
                      </button>
                    ) : null}
                    <button
                      onClick={() => void handleDelete(item)}
                      disabled={isDeleting}
                      className="rounded-full border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
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
