import { describe, expect, it } from "vitest";
import {
  isMissingEvalRunsTable,
  isUniqueViolation
} from "../persistence.js";

describe("eval persistence database errors", () => {
  it("recognizes wrapped undefined-table errors", () => {
    expect(
      isMissingEvalRunsTable({
        code: "XX000",
        cause: { cause: { code: "42P01" } }
      })
    ).toBe(true);
    expect(isMissingEvalRunsTable({ code: "42703" })).toBe(false);
  });

  it("recognizes wrapped unique violations", () => {
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation(new Error("duplicate"))).toBe(false);
  });
});
