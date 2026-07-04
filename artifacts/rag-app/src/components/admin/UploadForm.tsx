import { useState, type FormEvent } from "react";
import { uploadDocument } from "@/lib/api";

const ACCEPT =
  "application/pdf,image/png,image/jpeg,image/webp,text/markdown,text/plain,.md,.markdown,.docx";

interface UploadFormProps {
  /** Called after a successful upload so the parent can refresh the list. */
  onUploaded?: () => void;
}

export function UploadForm({ onUploaded }: UploadFormProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const form = event.currentTarget;
      const formData = new FormData(form);
      const fileInput = form.elements.namedItem("file");
      if (fileInput instanceof HTMLInputElement && !fileInput.files?.[0]) {
        setError("Select a file first");
        return;
      }
      const result = await uploadDocument(formData);
      if (!result.ok) {
        setError(result.error ?? "Upload failed");
        return;
      }
      form.reset();
      onUploaded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Title</span>
        <input
          type="text"
          name="title"
          required
          placeholder="e.g. Cancellation Policy v3"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">File</span>
        <input
          type="file"
          name="file"
          accept={ACCEPT}
          required
          className="text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:border-foreground/30"
        />
        <span className="text-xs text-muted-foreground">
          PDF / DOCX / PNG / JPG / WebP / Markdown / TXT. Max 20MB.
        </span>
      </label>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div>
        <button
          type="submit"
          disabled={busy}
          className="btn-primary px-4 py-1.5"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}
