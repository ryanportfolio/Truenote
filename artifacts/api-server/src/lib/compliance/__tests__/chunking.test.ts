import { describe, expect, it } from "vitest";
import { chunkComplianceDocument, passageId } from "../chunking.js";
import { buildBm25Index, tokenize } from "../bm25.js";

const ENTRY = { slug: "ssp", title: "System security plan", version: "2.0", sha256: "a".repeat(64) };

describe("chunkComplianceDocument", () => {
  it("keeps each passage inside one section with its heading path and exact offsets", () => {
    const markdown = [
      "# System security plan",
      "",
      "Intro text.",
      "",
      "## Access control",
      "",
      "### AC-2 Account management",
      "",
      "Accounts are reviewed quarterly.",
      "",
      "## Audit",
      "",
      "Logs are kept for one year.",
      ""
    ].join("\r\n");
    const passages = chunkComplianceDocument(ENTRY, markdown);
    expect(passages.map((passage) => passage.section)).toEqual([
      "System security plan",
      "System security plan > Access control > AC-2 Account management",
      "System security plan > Audit"
    ]);
    for (const passage of passages) {
      expect(markdown.slice(passage.sourceStart, passage.sourceEnd)).toBe(passage.content);
      expect(passage.content).not.toMatch(/\r$/);
    }
    expect(passages[1]!.content).toContain("Accounts are reviewed quarterly.");
    expect(passages.map((passage) => passage.ordinal)).toEqual([0, 1, 2]);
    expect(passages[0]!.id).toBe(passageId(ENTRY.slug, ENTRY.sha256, 0));
    // Identical text under another slug gets other ids.
    const twin = chunkComplianceDocument({ ...ENTRY, slug: "ssp-copy" }, markdown);
    expect(twin.map((passage) => passage.id)).not.toContain(passages[0]!.id);
  });

  it("does not read a heading inside a fenced code block", () => {
    const markdown = "## Real\n\n```\n# not a heading\n```\n\nAfter the fence.\n";
    const passages = chunkComplianceDocument(ENTRY, markdown);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.section).toBe("Real");
    expect(passages[0]!.content).toContain("# not a heading");
  });

  it("splits a long table at row boundaries and repeats its header in later pieces", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| POAM-${i + 1} | Fixture weakness number ${i + 1} | Open |`);
    const markdown = ["## Open items", "", "| Id | Weakness | Status |", "| --- | --- | --- |", ...rows, ""].join("\n");
    const passages = chunkComplianceDocument(ENTRY, markdown);
    expect(passages.length).toBeGreaterThan(1);
    for (const passage of passages) expect(passage.content.length).toBeLessThanOrEqual(1_600);
    for (const passage of passages.slice(1)) {
      expect(passage.content.startsWith("| Id | Weakness | Status |\n| --- | --- | --- |\n")).toBe(true);
      // Offsets cover the rows themselves, not the repeated header.
      expect(passage.content.endsWith(markdown.slice(passage.sourceStart, passage.sourceEnd))).toBe(true);
    }
    const all = passages.map((passage) => passage.content).join("\n");
    for (let i = 1; i <= 80; i += 1) expect(all).toContain(`| POAM-${i} |`);
  });

  it("skips a heading with nothing under it before a subheading", () => {
    const passages = chunkComplianceDocument(ENTRY, "# Title\n## Section\n\nBody.\n");
    expect(passages).toHaveLength(1);
    expect(passages[0]!.section).toBe("Title > Section");
  });
});

describe("compliance BM25", () => {
  it("keeps control ids whole and ranks the exact match first", () => {
    expect(tokenize("Control AC-2 and SI-4.")).toEqual(["control", "ac-2", "ac", "2", "si-4", "si", "4"]);
    const index = buildBm25Index([
      "AC-2 account management reviews",
      "SI-4 system monitoring",
      "General access policy"
    ]);
    expect(index.search("What does AC-2 require?", 3)[0]!.index).toBe(0);
    expect(index.search("zebra", 3)).toEqual([]);
  });
});
