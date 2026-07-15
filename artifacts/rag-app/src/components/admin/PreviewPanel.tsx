import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  approveDocumentVersion,
  getDocumentPreview,
  rejectDocumentVersion,
  rescanDocumentVersion,
  revokeDocumentVersion
} from "@/lib/api";
import type { PreviewResponse } from "@/types/api";

interface PreviewPanelProps {
  versionId: string;
  onClose: () => void;
  onChanged?: () => void;
}

export function PreviewPanel({
  versionId,
  onClose,
  onChanged
}: PreviewPanelProps): JSX.Element {
  const [data, setData] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [acknowledgeFindings, setAcknowledgeFindings] = useState(false);
  const [acting, setActing] = useState<"approve" | "reject" | "revoke" | "rescan" | null>(null);
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

  async function runAction(
    action: "approve" | "reject" | "revoke" | "rescan"
  ): Promise<void> {
    if ((action === "reject" || action === "revoke") && reviewNote.trim().length < 3) {
      setError("Enter a reason before rejecting or revoking this document.");
      return;
    }
    setActing(action);
    setError(null);
    try {
      if (action === "approve") {
        await approveDocumentVersion(versionId, {
          notes: reviewNote.trim(),
          acknowledgeFindings
        });
      } else if (action === "reject") {
        await rejectDocumentVersion(versionId, reviewNote.trim());
      } else if (action === "revoke") {
        await revokeDocumentVersion(versionId, reviewNote.trim());
      } else {
        await rescanDocumentVersion(versionId);
      }
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action} document`);
    } finally {
      setActing(null);
    }
  }

  const hasBlockingFindings = data?.findings.some((finding) => finding.blocking) ?? false;

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
        ) : (
          <div className="flex flex-col gap-4">
            <dl className="grid gap-3 rounded-lg border border-border bg-secondary p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Status</dt>
                <dd className="mt-1 capitalize">{data.lifecycleState.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Classification</dt>
                <dd className="mt-1 capitalize">{data.classification}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Approved source</dt>
                <dd className="mt-1">{data.sourceName ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Data owner</dt>
                <dd className="mt-1">{data.sourceOwner ?? "Unavailable"}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">Original location</dt>
                <dd className="mt-1 break-all font-mono text-[13px]">
                  {data.sourceOriginUri ?? "Not provided"}
                </dd>
              </div>
            </dl>

            {data.findings.length > 0 ? (
              <section aria-labelledby="scan-findings-title">
                <h2 id="scan-findings-title" className="text-sm font-semibold">
                  Scan findings
                </h2>
                <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {data.findings.map((finding) => (
                    <li key={finding.ruleId} className="px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>{finding.message}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                          {finding.severity} · {finding.count}
                        </span>
                      </div>
                      {finding.blocking ? (
                        <p className="mt-1 text-xs text-destructive">Blocks approval</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                {data.scanStatus === "clean"
                  ? "Malware scan clean. No local DLP or instruction-injection findings."
                  : data.scanStatus === "disabled"
                    ? "No file or content issues found."
                  : `Scan status: ${data.scanStatus}. No detailed findings were recorded.`}
              </p>
            )}

            {data.markdown === null ? (
              <p className="text-sm text-muted-foreground">
                The parsed text is not ready yet. Status: {data.parseStatus ?? "unknown"}.
              </p>
            ) : (
              <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-[13px] leading-relaxed">
                {data.markdown}
              </pre>
            )}
          </div>
        )}
      </div>
      {data && (data.canApprove || data.canReject || data.canRevoke || data.canRescan) ? (
        <footer className="border-t border-border bg-card p-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              {data.canApprove ? "Review note" : "Decision reason"}
            </span>
            <textarea
              value={reviewNote}
              onChange={(event) => setReviewNote(event.currentTarget.value)}
              rows={2}
              maxLength={2000}
              placeholder={
                data.canApprove
                  ? "Optional approval context"
                  : "Required for rejection or revocation"
              }
              className="resize-y rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          {data.canApprove && data.findings.length > 0 ? (
            <label className="mt-3 flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={acknowledgeFindings}
                onChange={(event) => setAcknowledgeFindings(event.currentTarget.checked)}
                className="mt-0.5 h-4 w-4 rounded border-input text-primary focus:ring-ring"
              />
              <span>I reviewed each non-blocking finding and accept it for this source.</span>
            </label>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {data.canApprove ? (
              <button
                type="button"
                onClick={() => void runAction("approve")}
                disabled={
                  acting !== null ||
                  hasBlockingFindings ||
                  (data.findings.length > 0 && !acknowledgeFindings)
                }
                className="btn-primary px-5 py-2 text-base"
              >
                {acting === "approve" ? "Approving…" : "Approve and activate"}
              </button>
            ) : null}
            {data.canReject ? (
              <button
                type="button"
                onClick={() => void runAction("reject")}
                disabled={acting !== null}
                className="rounded-full border border-destructive/40 px-3 py-2 text-sm text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {acting === "reject" ? "Rejecting…" : "Reject"}
              </button>
            ) : null}
            {data.canRevoke ? (
              <button
                type="button"
                onClick={() => void runAction("revoke")}
                disabled={acting !== null}
                className="rounded-full border border-destructive/40 px-3 py-2 text-sm text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {acting === "revoke" ? "Revoking…" : "Revoke now"}
              </button>
            ) : null}
            {data.canRescan ? (
              <button
                type="button"
                onClick={() => void runAction("rescan")}
                disabled={acting !== null}
                className="btn-whisper px-3 py-2 text-sm"
              >
                {acting === "rescan" ? "Starting…" : "Run scan again"}
              </button>
            ) : null}
          </div>
        </footer>
      ) : null}
    </aside>
  );
}
