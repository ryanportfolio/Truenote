import { useId, useMemo, useState, type ChangeEvent } from "react";
import { Download, Upload } from "lucide-react";
import { bulkCreateEvalQuestions } from "@/lib/api";
import {
  evalQuestionCsvTemplate,
  parseEvalQuestionCsv,
  type EvalCsvRow
} from "@/lib/csv";
import { cn } from "@/lib/utils";
import type { DocumentListItem, EvalQuestionItem } from "@/types/api";

const CHUNK_SIZE = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

type RowOutcome = { status: "added" } | { status: "failed"; error: string };

export function CsvImport({
  documents,
  expectedAnswerReady,
  scopeGeneration,
  onCreated
}: {
  documents: DocumentListItem[];
  expectedAnswerReady: boolean;
  scopeGeneration: number;
  onCreated: (items: EvalQuestionItem[], scopeGeneration: number) => void;
}): JSX.Element {
  const ids = useId();
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<EvalCsvRow[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Map<number, RowOutcome>>(() => new Map());
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  const templateHref = useMemo(
    () => `data:text/csv;charset=utf-8,${encodeURIComponent(evalQuestionCsvTemplate())}`,
    []
  );

  async function chooseFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    setRows(null);
    setFileError(null);
    setOutcomes(new Map());
    setImportError(null);
    setSummary(null);
    setFileName(file?.name ?? null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setFileError("The file is larger than 2 MB. Split it into smaller files.");
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      setFileError("The file could not be read.");
      return;
    }
    const parsed = parseEvalQuestionCsv(text, documents, { expectedAnswerReady });
    if (!parsed.ok) {
      setFileError(parsed.error);
      return;
    }
    if (parsed.rows.length === 0) {
      setFileError("The file has a header but no question rows.");
      return;
    }
    setRows(parsed.rows);
  }

  const ready = (rows ?? []).filter(
    (row) => row.payload !== null && outcomes.get(row.rowNumber)?.status !== "added"
  );
  const invalidCount = (rows ?? []).filter((row) => row.payload === null).length;

  async function runImport(): Promise<void> {
    if (ready.length === 0) return;
    setImporting(true);
    setImportError(null);
    setSummary(null);
    const next = new Map(outcomes);
    const created: EvalQuestionItem[] = [];
    let failed = 0;
    try {
      for (let start = 0; start < ready.length; start += CHUNK_SIZE) {
        const chunk = ready.slice(start, start + CHUNK_SIZE);
        const response = await bulkCreateEvalQuestions(
          chunk.map((row) => row.payload as NonNullable<EvalCsvRow["payload"]>)
        );
        const errors = new Map(response.errors.map((entry) => [entry.index, entry.error]));
        chunk.forEach((row, index) => {
          const error = errors.get(index);
          if (error !== undefined) {
            failed += 1;
            next.set(row.rowNumber, { status: "failed", error });
          } else {
            next.set(row.rowNumber, { status: "added" });
          }
        });
        created.push(...response.created);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message.trim() : "Import stopped";
      setImportError(
        `${message}${/[.!?]$/.test(message) ? "" : "."} Rows not marked Added were not saved; import again to retry them.`
      );
    } finally {
      setOutcomes(next);
      setImporting(false);
      if (created.length > 0) onCreated(created, scopeGeneration);
      setSummary(
        `Added ${created.length} question${created.length === 1 ? "" : "s"}.${
          failed > 0 ? ` ${failed} row${failed === 1 ? "" : "s"} failed on the server.` : ""
        }`
      );
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        One question per row. Columns: question (required), kind (answer or refuse),
        expected_answer, expected_source (a document title), expected_phrases (separated by
        semicolons), notes, held_out (true or false).
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor={`${ids}-file`} className="text-sm font-medium">
          CSV file
        </label>
        <input
          id={`${ids}-file`}
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => void chooseFile(event)}
          disabled={importing}
          className="max-w-full text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-solid file:border-border file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground hover:file:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <a
          href={templateHref}
          download="evaluation-questions-template.csv"
          className="inline-flex items-center gap-1.5 rounded-full text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Download className="h-4 w-4" aria-hidden />
          Download template
        </a>
      </div>

      {fileError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {fileName ? `${fileName}: ` : ""}
          {fileError}
        </p>
      ) : null}

      {rows ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm tabular-nums text-muted-foreground">
              {rows.length} row{rows.length === 1 ? "" : "s"} in {fileName}
              {invalidCount > 0 ? ` · ${invalidCount} need fixing and will be skipped` : ""}
            </p>
            <button
              type="button"
              className="btn-whisper gap-2 px-4 py-2 text-sm"
              onClick={() => void runImport()}
              disabled={importing || ready.length === 0}
            >
              <Upload className="h-4 w-4" aria-hidden />
              {importing
                ? "Importing…"
                : `Import ${ready.length} question${ready.length === 1 ? "" : "s"}`}
            </button>
          </div>
          {importError ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {importError}
            </p>
          ) : null}
          <p role="status" className={cn("text-sm", summary ? "text-foreground" : "sr-only")}>
            {summary ?? ""}
          </p>
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-12 px-3 py-2 font-medium">Row</th>
                  <th className="px-3 py-2 font-medium">Question</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">Expected</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <PreviewRow key={row.rowNumber} row={row} outcome={outcomes.get(row.rowNumber)} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}

function rowExpectation(row: EvalCsvRow): string {
  if (row.kind === "out-of-kb") return "Refusal";
  const parts = [
    row.expectedDocTitle ? `Source: ${row.expectedDocTitle}` : null,
    row.expectedPhrases.length > 0
      ? `${row.expectedPhrases.length} phrase${row.expectedPhrases.length === 1 ? "" : "s"}`
      : null,
    row.expectedAnswer ? "Expected answer" : null
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : "Nothing to check";
}

function PreviewRow({ row, outcome }: { row: EvalCsvRow; outcome: RowOutcome | undefined }): JSX.Element {
  const errors = outcome?.status === "failed" ? [outcome.error] : row.errors;
  return (
    <tr className="border-t border-border align-top hover:bg-muted/40">
      <td className="px-3 py-2 tabular-nums text-muted-foreground">{row.rowNumber}</td>
      <td className="px-3 py-2">
        <span className={cn(row.question ? "font-medium" : "italic text-muted-foreground")}>
          {row.question || "No question"}
        </span>
        <span className="mt-1 flex flex-wrap gap-1 text-xs">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-medium",
              row.kind === "in-kb" ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
            )}
          >
            {row.kind === "in-kb" ? "Answer" : "Refuse"}
          </span>
          {row.heldOut ? (
            <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
              Held-out
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground md:hidden">
          {rowExpectation(row)}
        </span>
      </td>
      <td className="hidden px-3 py-2 text-muted-foreground md:table-cell">{rowExpectation(row)}</td>
      <td className="px-3 py-2">
        {outcome?.status === "added" ? (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            Added
          </span>
        ) : errors.length > 0 ? (
          <ul className="flex flex-col gap-1 text-xs text-destructive">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-muted-foreground">Ready</span>
        )}
      </td>
    </tr>
  );
}
