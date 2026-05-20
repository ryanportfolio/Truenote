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
      className="flex flex-col gap-3 rounded border border-border bg-card p-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Title</span>
        <input
          type="text"
          name="title"
          required
          placeholder="e.g. Cancellation Policy v3"
          className="rounded border border-input bg-background px-2 py-1 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">File</span>
        <input
          type="file"
          name="file"
          accept={ACCEPT}
          required
          className="text-sm file:mr-3 file:rounded file:border-0 file:bg-secondary file:px-3 file:py-1 file:text-secondary-foreground"
        />
        <span className="text-xs text-muted-foreground">
          PDF / DOCX / PNG / JPG / WebP / Markdown / TXT. Max 20MB.
        </span>
      </label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div>
        <button
          type="submit"
          disabled={busy}
          className="btn-whisper px-3 py-1.5"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}
