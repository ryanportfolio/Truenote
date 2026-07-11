import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "../chunker.js";

const countChars = (text: string): number => text.length;

describe("chunkMarkdown source offsets", () => {
  it("anchors every text chunk to the exact parsed-markdown slice", () => {
    const markdown = [
      "",
      "# Cancellation Policy 😀",
      "",
      "Customers may cancel within **30 days**.",
      "",
      "",
      "## Standard Fees",
      "",
      "| Plan | Fee |",
      "| --- | --- |",
      "| Basic | $5 |",
      "",
      "- Escalate exceptions",
      "- Record the case"
    ].join("\n");

    const chunks = chunkMarkdown(markdown, {
      tokenize: countChars,
      targetTokens: 10_000
    });

    expect(chunks).toHaveLength(2);
    expect(
      markdown.slice(
        chunks[0]?.metadata.source_start,
        chunks[0]?.metadata.source_end
      )
    ).toBe(
      "# Cancellation Policy 😀\n\nCustomers may cancel within **30 days**."
    );
    expect(
      markdown.slice(
        chunks[1]?.metadata.source_start,
        chunks[1]?.metadata.source_end
      )
    ).toBe(
      [
        "## Standard Fees",
        "",
        "| Plan | Fee |",
        "| --- | --- |",
        "| Basic | $5 |",
        "",
        "- Escalate exceptions",
        "- Record the case"
      ].join("\n")
    );
  });

  it("keeps exclusive UTF-16 bounds when an oversized table is emitted alone", () => {
    const markdown = [
      "Intro.",
      "",
      "| Code | Meaning |",
      "| --- | --- |",
      "| 😀-1 | Special |",
      "",
      "After."
    ].join("\n");

    const chunks = chunkMarkdown(markdown, {
      tokenize: countChars,
      targetTokens: 10
    });
    const table = chunks.find((chunk) => chunk.metadata.segment_types?.includes("table"));

    expect(table).toBeDefined();
    expect(
      markdown.slice(table?.metadata.source_start, table?.metadata.source_end)
    ).toBe("| Code | Meaning |\n| --- | --- |\n| 😀-1 | Special |");
  });
});
