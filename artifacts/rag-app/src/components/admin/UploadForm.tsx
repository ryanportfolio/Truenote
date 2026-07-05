import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { uploadDocument } from "@/lib/api";

const ACCEPT =
  "application/pdf,image/png,image/jpeg,image/webp,text/markdown,text/plain,.md,.markdown,.docx";

/** Extensions the server's parser accepts — keep in sync with ACCEPT. */
const ACCEPT_EXTENSIONS = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "md",
  "markdown",
  "txt",
  "docx"
]);

const MAX_BYTES = 20 * 1024 * 1024;

interface UploadFormProps {
  /** Called after a successful upload so the parent can refresh the list. */
  onUploaded?: () => void;
  /**
   * Prefill for the Title field ("Fill this gap" deep link from /admin/gaps
   * arrives as ?title=<question>). When present, focus moves to the file
   * input — the title is already written.
   */
  initialTitle?: string;
}

export function UploadForm({ onUploaded, initialTitle }: UploadFormProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialTitle) fileRef.current?.focus();
  }, [initialTitle]);

  function validateFile(file: File): string | null {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPT_EXTENSIONS.has(ext)) {
      return `".${ext}" isn't a supported type. Use PDF, DOCX, PNG, JPG, WebP, Markdown, or TXT.`;
    }
    if (file.size > MAX_BYTES) {
      return "File is over the 20MB limit.";
    }
    return null;
  }

  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDragging(false);
    const files = event.dataTransfer.files;
    const file = files[0];
    if (!file) return;
    if (files.length > 1) {
      setError("One file at a time — drop a single document.");
      return;
    }
    const problem = validateFile(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    // Hand the dropped file to the real input so the normal FormData
    // submit path stays the single source of truth.
    if (fileRef.current) {
      const transfer = new DataTransfer();
      transfer.items.add(file);
      fileRef.current.files = transfer.files;
    }
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>): void {
    // dragleave fires when entering a child; only clear when actually
    // leaving the form's bounds.
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDragging(false);
  }

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
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card p-5 shadow-card transition-colors duration-100 ease-out",
        dragging ? "border-primary/40 bg-primary/5" : "border-border"
      )}
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Title</span>
        <input
          type="text"
          name="title"
          required
          maxLength={120}
          defaultValue={initialTitle}
          placeholder="e.g. Cancellation Policy v3"
          className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">File</span>
        <input
          ref={fileRef}
          type="file"
          name="file"
          accept={ACCEPT}
          required
          className="text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
        <span className="text-xs text-muted-foreground">
          PDF / DOCX / PNG / JPG / WebP / Markdown / TXT. Max 20MB. Or drop a file anywhere on
          this card.
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
          className="btn-primary px-5 py-2 text-base"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
    </form>
  );
}
