import { describe, expect, it } from "vitest";
import { validateGeneratedAnswer } from "../../generation/answer.js";
import { passageAsChunk } from "../ask.js";
import { chunkComplianceDocument } from "../chunking.js";

describe("passageAsChunk", () => {
  it("lets the figure gate see the section a deep passage belongs to", () => {
    const filler = Array.from({ length: 120 }, (_, i) => `Filler paragraph ${i} about reviews.`).join("\n\n");
    const markdown = `## AC-2 Account management\n\n${filler}\n\nAccess reviews happen every quarter.\n`;
    const passages = chunkComplianceDocument(
      { slug: "ssp", title: "System security plan", version: "2.0", sha256: "c".repeat(64) },
      markdown
    );
    const deep = passages.at(-1)!;
    expect(deep.content).not.toContain("AC-2");
    const chunk = passageAsChunk({ passage: deep, score: 1, neighbor: false });
    expect(chunk.content.endsWith(deep.content)).toBe(true);
    const result = validateGeneratedAnswer("AC-2 requires access reviews every quarter. [S1]", [chunk]);
    expect(result.failure).toBeNull();
  });
});
