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

export function parseUserCsv(input: string): ParsedUserCsv {
  const rows = csvRows(input.replace(/^\uFEFF/, ""));
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

