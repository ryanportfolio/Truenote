import type {
  DocumentListItem,
  EvalQuestionKind,
  SaveEvalQuestionRequest
} from "@/types/api";

/** Thrown for input that is not CSV at all (an unclosed quoted field). */
export class CsvSyntaxError extends Error {}

/**
 * RFC 4180 reader: comma separated, fields optionally wrapped in double
 * quotes, `""` inside quotes is one quote, commas and line breaks inside
 * quotes are data. Accepts CRLF, LF or bare CR line endings and drops a
 * leading byte-order mark. A quote inside an unquoted field is kept as text.
 * The trailing line break does not make an extra empty row.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;

  const endField = (): void => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\r") {
      if (text[index + 1] === "\n") index += 1;
      endRow();
    } else if (char === "\n") {
      endRow();
    } else {
      field += char;
      fieldStarted = true;
    }
  }

  if (quoted) {
    throw new CsvSyntaxError("A quoted field is never closed. Check for a missing quote.");
  }
  if (fieldStarted || field.length > 0 || row.length > 0) endRow();
  return rows;
}

/** One way to write a CSV field: quoted only when it has to be. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const EVAL_CSV_COLUMNS = [
  "question",
  "kind",
  "expected_answer",
  "expected_source",
  "expected_phrases",
  "notes",
  "held_out"
] as const;

/** Header plus two example rows, one of each kind. */
export function evalQuestionCsvTemplate(): string {
  const rows = [
    [...EVAL_CSV_COLUMNS],
    [
      "How long does a customer have to return a device?",
      "answer",
      "Within 30 days of purchase, with the original receipt.",
      "",
      "30 days;receipt",
      "Example row: replace with your own",
      "false"
    ],
    [
      "What will the weather be like tomorrow?",
      "refuse",
      "",
      "",
      "",
      "Off-topic, so the assistant should refuse",
      "true"
    ]
  ];
  return `${rows.map((row) => row.map(csvField).join(",")).join("\r\n")}\r\n`;
}

export interface EvalCsvRow {
  /** Line in the spreadsheet, counting the header as row 1. */
  rowNumber: number;
  question: string;
  kind: EvalQuestionKind;
  expectedAnswer: string | null;
  expectedDocId: string | null;
  expectedDocTitle: string | null;
  expectedPhrases: string[];
  notes: string | null;
  heldOut: boolean;
  /** Problems that keep this row from being imported. */
  errors: string[];
  /** Ready-to-send body when the row has no errors. */
  payload: SaveEvalQuestionRequest | null;
}

export type EvalCsvParseResult =
  | { ok: true; rows: EvalCsvRow[] }
  | { ok: false; error: string };

const MAX_TEXT = 2000;
const MAX_PHRASE = 500;
const MAX_PHRASES = 20;

function parseKind(raw: string): EvalQuestionKind | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "answer" || value === "in-kb") return "in-kb";
  if (value === "refuse" || value === "out-of-kb") return "out-of-kb";
  return null;
}

function parseBool(raw: string): boolean | null {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "false" || value === "no" || value === "0") return false;
  if (value === "true" || value === "yes" || value === "1") return true;
  return null;
}

/**
 * Turn an evaluation-question CSV into rows with per-row errors. The header
 * row is required; column names are matched case-insensitively and unknown
 * columns are ignored. Sources are matched by document title, ignoring case.
 */
export function parseEvalQuestionCsv(
  input: string,
  documents: Pick<DocumentListItem, "documentId" | "title">[],
  options: { expectedAnswerReady: boolean } = { expectedAnswerReady: true }
): EvalCsvParseResult {
  let grid: string[][];
  try {
    grid = parseCsv(input);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof CsvSyntaxError ? error.message : "The file could not be read as CSV."
    };
  }
  const nonEmpty = (row: string[]): boolean => row.some((cell) => cell.trim().length > 0);
  const headerIndex = grid.findIndex(nonEmpty);
  if (headerIndex < 0) return { ok: false, error: "The file is empty." };

  const header = (grid[headerIndex] ?? []).map((cell) => cell.trim().toLowerCase());
  const column = (name: (typeof EVAL_CSV_COLUMNS)[number]): number => header.indexOf(name);
  const questionColumn = column("question");
  if (questionColumn < 0) {
    return {
      ok: false,
      error: "The first row must be a header with a question column. Download the template to see the format."
    };
  }
  const columns = {
    kind: column("kind"),
    expectedAnswer: column("expected_answer"),
    expectedSource: column("expected_source"),
    expectedPhrases: column("expected_phrases"),
    notes: column("notes"),
    heldOut: column("held_out")
  };
  const byTitle = new Map<string, { documentId: string; title: string }>();
  for (const document of documents) {
    const key = document.title.trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, document);
  }

  const rows: EvalCsvRow[] = [];
  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    const cells = grid[index] ?? [];
    if (!nonEmpty(cells)) continue;
    const cell = (at: number): string => (at >= 0 ? (cells[at] ?? "").trim() : "");
    const errors: string[] = [];

    const question = cell(questionColumn);
    if (!question) errors.push("Question is empty.");
    else if (question.length > MAX_TEXT) errors.push(`Question is longer than ${MAX_TEXT} characters.`);

    const rawKind = cell(columns.kind);
    const parsedKind = parseKind(rawKind);
    if (parsedKind === null) errors.push(`Unknown kind "${rawKind}". Use answer or refuse.`);
    const kind = parsedKind ?? "in-kb";

    const expectedAnswer = cell(columns.expectedAnswer) || null;
    if (expectedAnswer && expectedAnswer.length > MAX_TEXT) {
      errors.push(`Expected answer is longer than ${MAX_TEXT} characters.`);
    }
    if (expectedAnswer && !options.expectedAnswerReady) {
      errors.push("Needs a database update before expected answers can be saved.");
    }

    const sourceTitle = cell(columns.expectedSource);
    const source = sourceTitle ? byTitle.get(sourceTitle.toLowerCase()) ?? null : null;
    if (sourceTitle && !source) errors.push(`No document titled "${sourceTitle}" in this program.`);

    const seen = new Set<string>();
    const expectedPhrases = cell(columns.expectedPhrases)
      .split(";")
      .map((phrase) => phrase.trim())
      .filter((phrase) => {
        const key = phrase.toLowerCase();
        if (!phrase || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (expectedPhrases.length > MAX_PHRASES) {
      errors.push(`Use at most ${MAX_PHRASES} expected phrases.`);
    }
    if (expectedPhrases.some((phrase) => phrase.length > MAX_PHRASE)) {
      errors.push(`Each expected phrase must be ${MAX_PHRASE} characters or fewer.`);
    }

    const notes = cell(columns.notes) || null;
    if (notes && notes.length > MAX_TEXT) errors.push(`Notes are longer than ${MAX_TEXT} characters.`);

    const rawHeldOut = cell(columns.heldOut);
    const heldOut = parseBool(rawHeldOut);
    if (heldOut === null) errors.push(`held_out "${rawHeldOut}" must be true or false.`);

    const hasExpectation = Boolean(expectedAnswer || sourceTitle || expectedPhrases.length > 0);
    if (parsedKind === "in-kb" && !hasExpectation) {
      errors.push("An answer question needs an expected answer, source, or phrase.");
    }
    if (parsedKind === "out-of-kb" && hasExpectation) {
      errors.push("A refuse question cannot have an expected answer, source, or phrases.");
    }

    rows.push({
      rowNumber: index + 1,
      question,
      kind,
      expectedAnswer,
      expectedDocId: source?.documentId ?? null,
      expectedDocTitle: source?.title ?? (sourceTitle || null),
      expectedPhrases,
      notes,
      heldOut: heldOut ?? false,
      errors,
      payload:
        errors.length > 0
          ? null
          : {
              kind,
              question,
              expectedDocId: kind === "in-kb" ? source?.documentId ?? null : null,
              expectedAnswerContains: kind === "in-kb" ? expectedPhrases : [],
              expectedAnswer: kind === "in-kb" ? expectedAnswer : null,
              isProtected: heldOut ?? false,
              notes
            }
    });
  }
  return { ok: true, rows };
}
