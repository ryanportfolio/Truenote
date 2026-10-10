import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildCompliancePages,
  COMPLIANCE_SOURCE_DIR,
  COMPLIANCE_STYLESHEET_HREF,
  renderComplianceMarkdown
} from "../../artifacts/rag-app/compliance-pages.js";

/**
 * Public compliance summaries are rendered from docs/security/compliance at
 * build time. Detailed documents (POA&M, full SSP, assessment results) must
 * never appear in this public repository or on these pages.
 */
const BANNED_TEXT = [
  "POAM-",
  ".tmp",
  "superuser",
  "railway.internal",
  "up.railway.app",
  "password"
];
const INTERNAL_EMAIL = /[a-z0-9._%+-]+@(?:truenote\.(?:org|example)|corewise\.[a-z]+)/i;

const pages = await buildCompliancePages();
const allPages: Array<[string, string]> = [
  ["index", pages.indexHtml],
  ...[...pages.pages.entries()]
];

describe("public compliance pages", () => {
  it("renders the index and at least one document page", () => {
    assert.ok(pages.pages.size >= 1);
    assert.ok(pages.pages.has("system-security-plan-summary"));
    for (const doc of pages.documents) {
      assert.ok(
        pages.indexHtml.includes(`href="/security/compliance/${doc.slug}/"`),
        `index must link to ${doc.slug}`
      );
    }
  });

  it("gives every page the shared stylesheet and no inline styles or scripts", () => {
    assert.ok(pages.css.includes("--primary: #0040ab"));
    for (const [slug, html] of allPages) {
      assert.ok(html.startsWith("<!doctype html>"), `${slug} must be a full document`);
      assert.ok(
        html.includes(`<link rel="stylesheet" href="${COMPLIANCE_STYLESHEET_HREF}">`),
        `${slug} must link the stylesheet`
      );
      assert.equal(/<style\b/i.test(html), false, `${slug} has an inline style block`);
      assert.equal(/<script\b/i.test(html), false, `${slug} has a script`);
      assert.equal(/\{\{[A-Z_]+\}\}/.test(html), false, `${slug} has an unfilled placeholder`);
      assert.equal(/(?:src|href)="(?:https?:)?\/\/(?!truenote\.org)/i.test(html), false, `${slug} loads an external resource`);
      assert.ok(html.includes('href="/compliance"'), `${slug} must link to the detailed documents`);
      assert.ok(html.includes('<link rel="canonical" href="https://truenote.org/security/compliance/'));
      assert.equal(html.includes("—"), false, `${slug} contains an em dash`);
    }
  });

  it("keeps internal and sensitive strings out of every page and source file", () => {
    const sources = ["template.html", "index.md", "system-security-plan-summary.md"].map(
      (name) => readFileSync(path.join(COMPLIANCE_SOURCE_DIR, name), "utf8")
    );
    for (const [label, text] of [
      ...allPages,
      ...sources.map((source, index) => [`source ${index}`, source] as [string, string])
    ]) {
      for (const banned of BANNED_TEXT) {
        assert.equal(
          text.toLowerCase().includes(banned.toLowerCase()),
          false,
          `${label} contains banned text: ${banned}`
        );
      }
      assert.equal(INTERNAL_EMAIL.test(text), false, `${label} contains an internal email address`);
    }
  });

  it("renders tables and escapes raw HTML and unsafe links in Markdown", () => {
    const html = renderComplianceMarkdown(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) ![logo](https://cdn.example/logo.png)"
    );
    assert.ok(html.includes('<div class="table-scroll"><table>'));
    assert.equal(/<script\b/i.test(html), false);
    assert.equal(/<img\b/i.test(html), false);
    assert.equal(html.includes("javascript:"), false);
    assert.equal(html.includes("cdn.example"), false);
    assert.ok(html.includes("&lt;script&gt;"));
  });

  it("keeps footnote reference ids so backlinks have a target", () => {
    const html = renderComplianceMarkdown("Claim[^1].\n\n[^1]: Supporting evidence.");
    const backlink = /href="#(user-content-fnref-[^"]+)"/.exec(html)?.[1];
    assert.ok(backlink, "footnote backlink missing");
    assert.ok(html.includes(`id="${backlink}"`), "footnote reference has no matching id");
  });

  it("refuses source files with unsafe names or missing front matter", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "compliance-src-"));
    try {
      writeFileSync(
        path.join(dir, "template.html"),
        readFileSync(path.join(COMPLIANCE_SOURCE_DIR, "template.html"))
      );
      writeFileSync(
        path.join(dir, "index.md"),
        "---\ntitle: Index\ndescription: Test\nupdated: 2026-10-10\n---\nBody\n"
      );
      writeFileSync(path.join(dir, "Bad_Name.md"), "---\ntitle: X\ndescription: Y\nupdated: 2026-10-10\n---\n");
      await assert.rejects(buildCompliancePages(dir), /file names must be lowercase/);
      rmSync(path.join(dir, "Bad_Name.md"));
      writeFileSync(path.join(dir, "no-front-matter.md"), "# Title\n");
      await assert.rejects(buildCompliancePages(dir), /missing front matter/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
