import { useState } from "react";
import { FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { deleteDocument, rescanDocumentVersion } from "@/lib/api";
import type { DocumentListItem } from "@/types/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { useConfirm } from "@/components/ConfirmDialog";
import { PreviewPanel } from "./PreviewPanel";

interface DocumentListProps {
  items: DocumentListItem[];
  /** Called after a review, rescan, revocation, or retirement. */
  onChanged?: () => void;
}

function StatusPill({ status }: { status: string }): JSX.Element {
  const s = status;
  const map: Record<string, string> = {
    submitted: "bg-muted text-muted-foreground",
    scanning: "bg-warning/20 text-warning-foreground",
    parsing: "bg-warning/20 text-warning-foreground",
    pending_review: "bg-warning/20 text-warning-foreground",
    active: "bg-success/15 text-success",
    retired: "bg-muted text-muted-foreground",
    quarantined: "bg-destructive/15 text-destructive",
    rejected: "bg-destructive/15 text-destructive",
    revoked: "bg-destructive/15 text-destructive",
    failed: "bg-destructive/15 text-destructive"
  };
  const labels: Record<string, string> = {
    submitted: "Submitted",
    scanning: "Scanning",
    parsing: "Parsing",
    pending_review: "Needs review",
    active: "Active",
    retired: "Retired",
    quarantined: "Quarantined",
    rejected: "Rejected",
    revoked: "Revoked",
    failed: "Failed"
  };
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        map[s] ?? "bg-muted text-muted-foreground",
        // The only in-progress state in the app gets the only ambient
        // motion — same precedent as the chat wait-stage pulse.
        ["scanning", "parsing"].includes(s) && "motion-safe:animate-pulse"
      )}
    >
      {labels[s] ?? s}
    </span>
  );
}

export function DocumentList({ items, onChanged }: DocumentListProps): JSX.Element {
  const [previewVersionId, setPreviewVersionId] = useState<string | null>(null);
  // Per-document delete state — keyed by documentId so we can disable just
  // the row being deleted (instead of blocking the whole table).
  const [changingId, setChangingId] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);
  const confirm = useConfirm();

  async function handleRetire(item: DocumentListItem): Promise<void> {
    const ok = await confirm({
      title: "Retire document?",
      message: `Retire "${item.title}"? It will immediately leave search and the knowledge base. Versions and source evidence remain under retention policy.`,
      confirmLabel: "Retire document",
      tone: "danger"
    });
    if (!ok) return;
    setChangeError(null);
    setChangingId(item.documentId);
    try {
      await deleteDocument(item.documentId, "Retired by an administrator after confirmation.");
      onChanged?.();
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : "Failed to retire document");
    } finally {
      setChangingId(null);
    }
  }

  async function handleRescan(item: DocumentListItem): Promise<void> {
    if (!item.versionId) return;
    setChangeError(null);
    setChangingId(item.documentId);
    try {
      await rescanDocumentVersion(item.versionId);
      onChanged?.();
    } catch (err) {
      setChangeError(err instanceof Error ? err.message : "Failed to rescan document");
    } finally {
      setChangingId(null);
    }
  }

  if (items.length === 0) {
    return (
      <EmptyState icon={FileText} title="No source documents yet" />
    );
  }

  return (
    <>
      {changeError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {changeError}
        </p>
      ) : null}
      {/* Header carried by type + rule, not fill. Secondary metadata folds
        * into the title cell on narrow screens instead of forcing a scrollbar. */}
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <table className="w-full text-sm tabular-nums">
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Source</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isChanging = changingId === item.documentId;
            const versionId = item.versionId;
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
                  <span className="mt-1 block text-xs font-normal capitalize text-muted-foreground">
                    {item.classification}
                    {item.findings.length > 0
                      ? ` · ${item.findings.length} scan finding${item.findings.length === 1 ? "" : "s"}`
                      : ""}
                  </span>
                </td>
                <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                  <span className="block text-foreground">{item.sourceName ?? "Unknown source"}</span>
                  <span className="mt-1 block text-xs">{item.sourceOwner ?? "Owner unavailable"}</span>
                </td>
                <td className="px-3 py-2">
                  <StatusPill status={item.lifecycleState} />
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {versionId && item.parseStatus === "ready" ? (
                      <button
                        onClick={() => setPreviewVersionId(versionId)}
                        disabled={isChanging}
                        className="btn-whisper px-2.5 py-1 text-xs"
                      >
                        {item.canApprove ? "Review" : "Details"}
                      </button>
                    ) : null}
                    {item.canRescan && versionId ? (
                      <button
                        onClick={() => void handleRescan(item)}
                        disabled={isChanging}
                        className="btn-whisper px-2.5 py-1 text-xs"
                      >
                        {isChanging ? "Starting…" : "Rescan"}
                      </button>
                    ) : null}
                    {item.lifecycleState !== "rejected" ? (
                      <button
                        onClick={() => void handleRetire(item)}
                        disabled={isChanging || item.lifecycleState === "retired"}
                        className="rounded-full border border-destructive/40 px-2.5 py-1 text-xs text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {isChanging ? "Working…" : "Retire"}
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {previewVersionId ? (
        <PreviewPanel
          versionId={previewVersionId}
          onClose={() => setPreviewVersionId(null)}
          onChanged={() => {
            setPreviewVersionId(null);
            onChanged?.();
          }}
        />
      ) : null}
    </>
  );
}
