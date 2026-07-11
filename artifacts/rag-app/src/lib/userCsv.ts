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
 * Normalize spreadsheet rows (mixed-type cells from an .xlsx reader \u2014
 * strings, numbers, dates, or null for blanks) into the trimmed-string
 * grid extractUserEmails expects, then extract. Kept here (not in the
 * component) so it's unit-testable without the binary xlsx parser.
 */
export function parseUserXlsx(
  rows: ReadonlyArray<ReadonlyArray<unknown>>
): ParsedUserCsv {
  const grid = rows.map((row) =>
    row.map((cell) => (cell == null ? "" : String(cell)))
  );
  return extractUserEmails(grid);
}

