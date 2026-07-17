import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocMarkdown } from "../KnowledgeBaseDocument";

const markdown = [
  "# Policy",
  "",
  "See [policy details][policy] before cancelling.",
  "",
  "Next paragraph.",
  "",
  "[policy]: https://example.com/policy"
].join("\n");

describe("DocMarkdown citation anchors", () => {
  it("marks overlapping AST blocks without splitting document-wide Markdown", () => {
    const sourceStart = markdown.indexOf("See");
    const sourceEnd = sourceStart + "See [policy details][policy] before cancelling.".length;
    const cited = renderToStaticMarkup(
      <DocMarkdown
        markdown={markdown}
        citationTarget={{ excerpt: "See policy details before cancelling.", sourceStart, sourceEnd }}
      />
    );
    const plain = renderToStaticMarkup(
      <DocMarkdown markdown={markdown} citationTarget={null} />
    );

    expect(cited).toContain('data-citation-target="true"');
    expect(cited).toContain('href="https://example.com/policy"');
    for (const expectedText of [
      "Policy",
      "See ",
      "policy details",
      " before cancelling.",
      "Next paragraph."
    ]) {
      expect(cited).toContain(expectedText);
      expect(plain).toContain(expectedText);
    }
    expect(cited.match(/href=/g)).toHaveLength(1);
    expect(plain.match(/href=/g)).toHaveLength(1);
  });
});
