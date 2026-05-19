import { useCallback, useEffect, useState } from "react";
import { listDocuments } from "@/lib/api";
import type { DocumentListItem } from "@/types/api";
import { UploadForm } from "@/components/admin/UploadForm";
import { DocumentList } from "@/components/admin/DocumentList";

export function AdminPage(): JSX.Element {
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const { items } = await listDocuments();
      setItems(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Documents</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload SOPs, policies, screenshots, and tables. After parsing, click Preview to verify the
          parse before the version becomes active.
        </p>
      </header>
      <UploadForm onUploaded={() => void refresh()} />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : (
        <DocumentList items={items} />
      )}
    </div>
  );
}
