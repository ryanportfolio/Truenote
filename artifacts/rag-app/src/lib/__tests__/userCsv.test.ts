import { describe, expect, it } from "vitest";
import { parseUserCsv, parseUserXlsx } from "../userCsv";

describe("parseUserCsv", () => {
  it("reads a named email column and deduplicates case-insensitively", () => {
    expect(
      parseUserCsv(
        "name,email\nAlice,ALICE@example.com\nDuplicate,alice@example.com\nBob,bob@example.com"
      )
    ).toEqual({
      emails: ["alice@example.com", "bob@example.com"],
      invalidRows: []
    });
  });

  it("accepts a headerless one-email-per-row file", () => {
    expect(parseUserCsv("alice@example.com\r\nbob@example.com\r\n")).toEqual({
      emails: ["alice@example.com", "bob@example.com"],
      invalidRows: []
    });
  });

  it("reports invalid source rows", () => {
    expect(parseUserCsv("email\nvalid@example.com\nnot-an-email\n")).toEqual({
      emails: ["valid@example.com"],
      invalidRows: [3]
    });
  });
});

describe("parseUserXlsx", () => {
  it("reads a named email column from spreadsheet rows", () => {
    expect(
      parseUserXlsx([
        ["name", "email"],
        ["Alice", "ALICE@example.com"],
        ["Duplicate", "alice@example.com"],
        ["Bob", "bob@example.com"]
      ])
    ).toEqual({
      emails: ["alice@example.com", "bob@example.com"],
      invalidRows: []
    });
  });

  it("stringifies non-string cells and skips blank/null rows", () => {
    // xlsx readers hand back numbers, Dates, and null for empty cells.
    expect(
      parseUserXlsx([
        ["carol@example.com"],
        [null],
        [42],
        ["dave@example.com"]
      ])
    ).toEqual({
      emails: ["carol@example.com", "dave@example.com"],
      invalidRows: [3]
    });
  });

  it("reads the first sheet's data from read-excel-file's Sheet[] result", () => {
    // read-excel-file v9's default export resolves to Sheet[] =
    // [{ sheet, data }]. Only the first sheet's grid is used.
    expect(
      parseUserXlsx([
        { sheet: "People", data: [["email"], ["alice@example.com"]] },
        { sheet: "Other", data: [["ignored@example.com"]] }
      ])
    ).toEqual({
      emails: ["alice@example.com"],
      invalidRows: []
    });
  });

  it("returns nothing for shapes it doesn't recognize", () => {
    expect(parseUserXlsx(null)).toEqual({ emails: [], invalidRows: [] });
    expect(parseUserXlsx({})).toEqual({ emails: [], invalidRows: [] });
    expect(parseUserXlsx([])).toEqual({ emails: [], invalidRows: [] });
  });
});

