import { useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import { uploadDocument } from "@/lib/api";
import type { ContentSourceItem } from "@/types/api";

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
const MAX_BATCH_FILES = 20;
const UPLOAD_CONCURRENCY = 3;

type FileUploadStatus = "ready" | "uploading" | "uploaded" | "failed";

interface FileUploadResult {
  name: string;
  status: FileUploadStatus;
  error?: string;
}

interface UploadFormProps {
  /** Called after one or more successful uploads so the parent can refresh the list. */
  onUploaded?: () => void;
  /**
   * Prefill for the Title field ("Fill this gap" deep link from /admin/gaps
   * arrives as ?title=<question>). When present, focus moves to the file
   * input — the title is already written.
   */
  initialTitle?: string;
  sources: ContentSourceItem[];
}

function defaultTitle(file: File): string {
  return file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Untitled document";
}

function statusLabel(status: FileUploadStatus): string {
  switch (status) {
    case "uploading":
      return "Uploading…";
    case "uploaded":
      return "Uploaded";
    case "failed":
      return "Failed";
    default:
      return "Ready";
  }
}

export function UploadForm({
  onUploaded,
  initialTitle,
  sources
}: UploadFormProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sourceId, setSourceId] = useState("");
  const [includeSourceOrigin, setIncludeSourceOrigin] = useState(false);
  const [title, setTitle] = useState(initialTitle ?? "");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<FileUploadResult[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialTitle !== undefined) setTitle(initialTitle);
    if (initialTitle) fileRef.current?.focus();
  }, [initialTitle]);

  useEffect(() => {
    if (sources.some((source) => source.id === sourceId)) return;
    setSourceId(sources[0]?.id ?? "");
  }, [sourceId, sources]);

  const selectedSource = sources.find((source) => source.id === sourceId) ?? null;
  const displayedFiles: FileUploadResult[] =
    fileResults.length > 0
      ? fileResults
      : selectedFiles.map((file) => ({
          name: file.name,
          status: "ready" as const
        }));

  function setInputFiles(files: File[]): void {
    const input = fileRef.current;
    if (!input) return;
    if (files.length === 0) {
      input.value = "";
      return;
    }
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
  }

  function validateFile(file: File): string | null {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ACCEPT_EXTENSIONS.has(ext)) {
      return `".${ext}" isn't supported`;
    }
    if (file.size > MAX_BYTES) {
      return "over the 20MB limit";
    }
    return null;
  }

  function selectFiles(files: File[]): void {
    setSuccess(null);
    setFileResults([]);
    if (files.length > MAX_BATCH_FILES) {
      setSelectedFiles([]);
      setInputFiles([]);
      setError(`Choose up to ${MAX_BATCH_FILES} documents at a time.`);
      return;
    }

    const valid: File[] = [];
    const problems: string[] = [];
    files.forEach((file) => {
      const problem = validateFile(file);
      if (problem) problems.push(`${file.name}: ${problem}`);
      else valid.push(file);
    });

    setSelectedFiles(valid);
    setInputFiles(valid);
    if (valid.length === 1 && title.trim() === "") {
      setTitle(defaultTitle(valid[0]!));
    }
    setError(
      problems.length > 0
        ? `${problems.join("; ")}. ${valid.length > 0 ? "The other files remain selected." : ""}`.trim()
        : null
    );
  }

  function handleDrop(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDragging(false);
    selectFiles(Array.from(event.dataTransfer.files));
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>): void {
    event.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>): void {
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
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file");
    const files =
      fileInput instanceof HTMLInputElement
        ? Array.from(fileInput.files ?? [])
        : [];
    if (files.length === 0) {
      setError("Select at least one file");
      return;
    }
    if (files.length === 1 && title.trim() === "") {
      setError("Enter a document name");
      return;
    }

    const common = new FormData(form);
    const classification = common.get("classification");
    const sourceOriginUri = common.get("sourceOriginUri");
    setBusy(true);
    setError(null);
    setSuccess(null);
    setFileResults(
      files.map((file) => ({ name: file.name, status: "ready" }))
    );

    let cursor = 0;
    let succeeded = 0;
    const failedFiles: File[] = [];
    const updateResult = (
      index: number,
      status: FileUploadStatus,
      fileError?: string
    ) => {
      setFileResults((current) =>
        current.map((result, resultIndex) =>
          resultIndex === index
            ? { name: result.name, status, ...(fileError ? { error: fileError } : {}) }
            : result
        )
      );
    };

    const worker = async () => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        const file = files[index]!;
        updateResult(index, "uploading");

        const upload = new FormData();
        upload.set("title", files.length === 1 ? title.trim() : defaultTitle(file));
        upload.set("sourceId", sourceId);
        if (typeof classification === "string") {
          upload.set("classification", classification);
        }
        if (typeof sourceOriginUri === "string" && sourceOriginUri.trim() !== "") {
          upload.set("sourceOriginUri", sourceOriginUri);
        }
        upload.set("file", file);

        try {
          const result = await uploadDocument(upload);
          if (!result.ok) throw new Error(result.error ?? "Upload failed");
          succeeded += 1;
          updateResult(index, "uploaded");
        } catch (uploadError) {
          failedFiles.push(file);
          updateResult(
            index,
            "failed",
            uploadError instanceof Error ? uploadError.message : "Upload failed"
          );
        }
      }
    };

    try {
      await Promise.all(
        Array.from(
          { length: Math.min(UPLOAD_CONCURRENCY, files.length) },
          () => worker()
        )
      );

      if (succeeded > 0) onUploaded?.();
      if (failedFiles.length === 0) {
        form.reset();
        setInputFiles([]);
        setSelectedFiles([]);
        setTitle("");
        setIncludeSourceOrigin(false);
        setSuccess(
          `${files.length} document${files.length === 1 ? "" : "s"} uploaded and queued for processing.`
        );
      } else {
        setSelectedFiles(failedFiles);
        setInputFiles(failedFiles);
        if (failedFiles.length === 1) setTitle(defaultTitle(failedFiles[0]!));
        setError(
          `${failedFiles.length} of ${files.length} upload${files.length === 1 ? "" : "s"} failed. Successful documents are already processing.`
        );
        if (succeeded > 0) {
          setSuccess(
            `${succeeded} document${succeeded === 1 ? "" : "s"} uploaded successfully.`
          );
        }
      }
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
      {selectedFiles.length > 1 ? (
        <div className="rounded-md border border-border bg-secondary/50 px-3 py-2 text-sm">
          <span className="font-medium">Document names</span>
          <p className="mt-1 text-xs text-muted-foreground">
            Filenames become titles. Approved source, classification, and optional source
            location apply to every selected document.
          </p>
        </div>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Document name</span>
          <input
            type="text"
            name="title"
            required
            maxLength={120}
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            disabled={busy}
            placeholder="e.g. Cancellation Policy v3"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Approved source</span>
          <select
            name="sourceId"
            required
            value={sourceId}
            onChange={(event) => setSourceId(event.currentTarget.value)}
            disabled={busy || sources.length === 0}
            className="select-quiet rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sources.length === 0 ? <option value="">No approved sources</option> : null}
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">
            {selectedSource
              ? `Data owner: ${selectedSource.ownerName}`
              : "An authorized data steward must register a source first."}
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Data classification</span>
          <select
            name="classification"
            required
            defaultValue="internal"
            disabled={busy}
            className="select-quiet rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="public">Public</option>
            <option value="internal">Internal</option>
            <option value="confidential">Confidential</option>
            <option value="restricted">Restricted</option>
          </select>
        </label>
      </div>
      <div className="rounded-md border border-border bg-secondary/50 p-3">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={includeSourceOrigin}
            onChange={(event) => setIncludeSourceOrigin(event.currentTarget.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 cursor-pointer rounded-sm border-input text-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="flex flex-col gap-1">
            <span className="font-medium">Add original source location</span>
            <span className="text-xs text-muted-foreground">
              Optional. Record where the source-of-truth came from. Truenote does not fetch
              this address.
            </span>
          </span>
        </label>
        {includeSourceOrigin ? (
          <label className="mt-3 flex flex-col gap-1 text-sm">
            <span className="font-medium">Original source location</span>
            <input
              type="text"
              name="sourceOriginUri"
              required
              maxLength={2048}
              disabled={busy}
              placeholder="https://company.sharepoint.com/sites/operations/policy.pdf"
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Files</span>
        <input
          ref={fileRef}
          type="file"
          name="file"
          accept={ACCEPT}
          required
          multiple
          disabled={busy}
          onChange={(event) =>
            selectFiles(Array.from(event.currentTarget.files ?? []))
          }
          className="text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <span className="text-xs text-muted-foreground">
          Select or drop up to {MAX_BATCH_FILES} documents. PDF / DOCX / PNG / JPG / WebP /
          Markdown / TXT. Max 20MB each.
        </span>
      </label>

      {displayedFiles.length > 1 || fileResults.length > 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="overflow-hidden rounded-md border border-border"
        >
          <ul className="divide-y divide-border text-sm">
            {displayedFiles.map((file, index) => (
              <li key={`${file.name}-${index}`} className="px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">{file.name}</span>
                  <span
                    className={cn(
                      "shrink-0 text-xs",
                      file.status === "uploaded"
                        ? "text-success"
                        : file.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground"
                    )}
                  >
                    {statusLabel(file.status)}
                  </span>
                </div>
                {file.error ? (
                  <p className="mt-1 text-xs text-destructive">{file.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {success ? (
        <p
          role="status"
          className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
        >
          {success}
        </p>
      ) : null}
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
          disabled={busy || sources.length === 0}
          className="btn-primary px-5 py-2 text-base"
        >
          {busy
            ? `Uploading ${selectedFiles.length} document${selectedFiles.length === 1 ? "" : "s"}…`
            : sources.length === 0
              ? "Source required"
              : selectedFiles.length > 1
                ? `Upload ${selectedFiles.length} documents`
                : "Upload"}
        </button>
      </div>
    </form>
  );
}
