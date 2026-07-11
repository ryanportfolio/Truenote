import { describe, expect, it } from "vitest";
import { parseUserCsv } from "../userCsv";

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

