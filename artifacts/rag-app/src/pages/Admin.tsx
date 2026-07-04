import { useCallback, useEffect, useState } from "react";
import { listDocuments } from "@/lib/api";
import type { CurrentUser, DocumentListItem } from "@/types/api";
import { UploadForm } from "@/components/admin/UploadForm";
import { DocumentList } from "@/components/admin/DocumentList";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";

const POLL_INTERVAL_MS = 2000;

interface AdminPageProps {
  user: CurrentUser;
}

export function AdminPage({ user }: AdminPageProps): JSX.Element {
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Super_user without a program selected: server returns
  // noProgramSelected:true with an empty list. Render a friendly
  // prompt instead of "no documents" (which is ambiguous).
  const [noProgramSelected, setNoProgramSelected] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await listDocuments();
      setItems(response.items);
      setNoProgramSelected(response.noProgramSelected === true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Refetch when the super_user changes their program selection. The
  // picker writes to localStorage and fires SELECTED_PROGRAM_CHANGED_EVENT
  // in the same tab; `storage` covers cross-tab updates.
  useEffect(() => {
    function reload(): void {
      setLoading(true);
      void refresh();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [refresh]);

  // Auto-refresh while any document is mid-ingestion. Polling stops as soon
  // as every doc reaches a terminal state (ready / failed) so an idle page
  // costs nothing. The setTimeout is scheduled fresh on each items change,
  // so a successful refresh that resolves all in-flight docs naturally
  // breaks the chain.
  useEffect(() => {
    const hasInFlight = items.some(
      (item) => item.parseStatus === "pending" || item.parseStatus === "parsing"
    );
    if (!hasInFlight) return;
    const timer = setTimeout(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [items, refresh]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload SOPs, policies, screenshots, and tables. After parsing, click Preview to verify the
          parse before the version becomes active.
        </p>
      </header>
      {noProgramSelected ? (
        <div
          role="status"
          className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          {user.role === "super_user"
            ? "Select a program from the picker in the header to view or upload documents."
            : // The DB CHECK constraint guarantees non-super_user roles
              // always have a non-null program_id, so this branch is
              // server-contract-unreachable. We render a friendly
              // fallback rather than a 500-style "this shouldn't
              // happen" to avoid scaring CSRs if the contract ever
              // drifts.
              "Your account isn't scoped to a program yet. Contact an admin."}
        </div>
      ) : (
        <UploadForm onUploaded={() => void refresh()} />
      )}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : noProgramSelected ? null : (
        <DocumentList items={items} onDeleted={() => void refresh()} />
      )}
    </div>
  );
}
