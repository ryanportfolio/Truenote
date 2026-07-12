import { useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { deleteDocument } from "@/lib/api";
import type { DocumentListItem } from "@/types/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { useConfirm } from "@/components/ConfirmDialog";
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
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        map[s] ?? map["pending"],
        // The only in-progress state in the app gets the only ambient
        // motion — same precedent as the chat wait-stage pulse.
        s === "parsing" && "motion-safe:animate-pulse"
      )}
    >
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
  const confirm = useConfirm();

  async function handleDelete(item: DocumentListItem): Promise<void> {
    const ok = await confirm({
      title: "Delete document?",
      message: `Delete "${item.title}"? This removes the document, all its versions, and all its chunks. Citations in past chats may stop resolving.`,
      confirmLabel: "Delete document",
      tone: "danger"
    });
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
      <EmptyState icon={FileText} title="No source documents yet" />
    );
  }

  return (
    <>
      {deleteError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {deleteError}
        </p>
      ) : null}
      {/* Header carried by type + rule, not fill. Secondary metadata folds
        * into the title cell on narrow screens instead of forcing a scrollbar. */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <table className="w-full text-sm tabular-nums">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Uploaded</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isDeleting = deletingId === item.documentId;
            return (
              <tr
                key={item.documentId}
                className="border-t border-border transition-colors duration-100 ease-out hover:bg-muted/40"
              >
                <td className="min-w-0 px-3 py-2 font-medium">
                  <span className="line-clamp-2">{item.title}</span>
                  <span className="mt-1 block text-xs font-normal text-muted-foreground sm:hidden">
                    {item.uploadedAt ? <RelativeTime iso={item.uploadedAt} /> : "Upload time unavailable"}
                  </span>
                </td>
                <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                  {item.uploadedAt ? <RelativeTime iso={item.uploadedAt} /> : "—"}
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={item.parseStatus} />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {item.versionId && item.parseStatus === "ready" ? (
                      <button
                        onClick={() => setPreviewVersionId(item.versionId)}
                        disabled={isDeleting}
                        className="btn-whisper px-2.5 py-1 text-xs"
                      >
                        Parsed text
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
      </div>

      {previewVersionId ? (
        <PreviewPanel versionId={previewVersionId} onClose={() => setPreviewVersionId(null)} />
      ) : null}
    </>
  );
}
