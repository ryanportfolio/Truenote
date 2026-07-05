import { describe, it, expect } from "vitest";
import { annotateCitations, answerForClipboard } from "../citation-rendering";
import type { Source } from "@/types/api";

const src = (id: string, title = "Doc"): Source => ({
  chunk_id: id,
  doc_title: title,
  excerpt: `excerpt of ${id}`,
  doc_id: null
});

describe("annotateCitations", () => {
  it("rewrites a known citation to a numbered #cite: link", () => {
    const { markdown, ordinals } = annotateCitations("The fee is $5 [c1].", [src("c1")]);
    expect(markdown).toBe("The fee is $5 [1](#cite:c1).");
    expect(ordinals.get("c1")).toBe(1);
  });

  it("assigns the same ordinal to repeated chunk_ids", () => {
    const { markdown, ordinals } = annotateCitations("[c1] and [c1] and [c2]", [
      src("c1"),
      src("c2")
    ]);
    expect(markdown).toBe("[1](#cite:c1) and [1](#cite:c1) and [2](#cite:c2)");
    expect(ordinals.get("c1")).toBe(1);
    expect(ordinals.get("c2")).toBe(2);
  });

  it("rewrites an unknown chunk_id to a #cite-unknown link with the raw text", () => {
    const { markdown } = annotateCitations("Per [ghost].", [src("c1")]);
    expect(markdown).toBe("Per [\\[ghost\\]](#cite-unknown).");
  });

  it("leaves answers without citations untouched", () => {
    const { markdown, ordinals } = annotateCitations("Plain answer, no citations.", []);
    expect(markdown).toBe("Plain answer, no citations.");
    expect(ordinals.size).toBe(0);
  });

  it("keeps surrounding markdown intact", () => {
    const { markdown } = annotateCitations(
      "1. Open the account tab [c1].\n2. Click **Cancel plan** [c1].",
      [src("c1")]
    );
    expect(markdown).toBe(
      "1. Open the account tab [1](#cite:c1).\n2. Click **Cancel plan** [1](#cite:c1)."
    );
  });
});

describe("answerForClipboard", () => {
  it("replaces known citations with ordinals and keeps unknown brackets verbatim", () => {
    const text = answerForClipboard("Fee is $5 [c1], see [ghost] and [c2].", [
      src("c1"),
      src("c2")
    ]);
    expect(text).toBe("Fee is $5 [1], see [ghost] and [2].");
  });

  it("uses the same ordinal for repeated citations", () => {
    const text = answerForClipboard("[c1] then [c1]", [src("c1")]);
    expect(text).toBe("[1] then [1]");
  });
});
