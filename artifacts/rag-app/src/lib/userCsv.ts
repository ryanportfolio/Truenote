const EMAIL_HEADERS = new Set(["email", "email address", "e-mail"]);
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export interface ParsedUserCsv {
  emails: string[];
  invalidRows: number[];
}

function csvRows(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Pull the email column out of a parsed grid, whatever produced it (CSV
 * text or a spreadsheet reader). Detects a named email header, else falls
 * back to the first column; dedupes case-insensitively; reports 1-based
 * source-row numbers for cells that aren't valid emails.
 */
export function extractUserEmails(rows: string[][]): ParsedUserCsv {
  if (rows.length === 0) return { emails: [], invalidRows: [] };

  const first = rows[0] ?? [];
  const headerIndex = first.findIndex((field) =>
    EMAIL_HEADERS.has(field.trim().toLowerCase())
  );
  const emailIndex = headerIndex >= 0 ? headerIndex : 0;
  const startIndex = headerIndex >= 0 ? 1 : 0;
  const emails: string[] = [];
  const seen = new Set<string>();
  const invalidRows: number[] = [];

  for (let index = startIndex; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    if (row.every((field) => field.trim().length === 0)) continue;
    const email = (row[emailIndex] ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      invalidRows.push(index + 1);
      continue;
    }
    if (!seen.has(email)) {
      seen.add(email);
      emails.push(email);
    }
  }

  return { emails, invalidRows };
}

export function parseUserCsv(input: string): ParsedUserCsv {
  return extractUserEmails(csvRows(input.replace(/^\uFEFF/, "")));
}

/**
 * Pull the first sheet's row grid out of whatever read-excel-file's
 * default export resolved to. v9 returns `Sheet[]` \u2014 an array of
 * `{ sheet, data }` objects, where `data` is the 2D cell grid \u2014 so we take
 * the first sheet's `data`. A legacy/other `Row[][]` shape (the array's
 * first element is itself a row array) is accepted as-is. Anything else
 * yields an empty grid rather than throwing.
 */
function firstSheetRows(result: unknown): ReadonlyArray<ReadonlyArray<unknown>> {
  if (!Array.isArray(result)) return [];
  const first = result[0];
  if (Array.isArray(first)) {
    // Row[][] \u2014 the whole result is already the grid.
    return result as ReadonlyArray<ReadonlyArray<unknown>>;
  }
  if (
    first &&
    typeof first === "object" &&
    Array.isArray((first as { data?: unknown }).data)
  ) {
    return (first as { data: ReadonlyArray<ReadonlyArray<unknown>> }).data;
  }
  return [];
}

/**
 * Extract emails from an .xlsx reader's output. Takes the reader's raw
 * result (typed `unknown` so the caller passes it straight through, and so
 * this stays unit-testable without the binary parser), reduces it to the
 * first sheet's grid, stringifies mixed-type cells (numbers, dates, null
 * blanks), then runs the shared email extractor.
 */
export function parseUserXlsx(result: unknown): ParsedUserCsv {
  const grid = firstSheetRows(result).map((row) =>
    (Array.isArray(row) ? row : []).map((cell) =>
      cell == null ? "" : String(cell)
    )
  );
  return extractUserEmails(grid);
}

