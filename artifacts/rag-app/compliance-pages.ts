/**
 * Build-time renderer for the public compliance summaries in
 * docs/security/compliance/. vite.config.ts publishes the result at
 * /security/compliance/ (index) and /security/compliance/<slug>/ (one page
 * per Markdown file) in development and builds; the API server serves the
 * built files in production (app.ts).
 *
 * Markdown is rendered with the SPA's own react-markdown + remark-gfm stack
 * through react-dom/server, so no new dependency is needed. react-markdown
 * never emits raw HTML from the source: tags in the Markdown come out as
 * escaped text, and unsafe link protocols are dropped. Images become a text
 * placeholder so a page never loads an external resource.
 *
 * Detailed compliance documents (POA&M, full SSP, assessment results) are
 * never stored here. They live in object storage and are served only to
 * signed-in super users (api-server routes/compliance.ts).
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export const COMPLIANCE_SOURCE_DIR = fileURLToPath(
  new URL("../../docs/security/compliance/", import.meta.url)
);
export const COMPLIANCE_ROUTE = "/security/compliance/";
export const COMPLIANCE_STYLESHEET_HREF = "/security/compliance/styles.css";
/** Same pattern the API server checks before serving a page (lib/compliance/documents.ts). */
export const COMPLIANCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX_LENGTH = 80;
const CANONICAL_ORIGIN = "https://truenote.org";

export interface CompliancePageMeta {
  slug: string;
  title: string;
  description: string;
  updated: string;
}

export interface CompliancePages {
  css: string;
  /** Index page, published at /security/compliance/. */
  indexHtml: string;
  /** Document pages by slug, published at /security/compliance/<slug>/. */
  pages: Map<string, string>;
  documents: CompliancePageMeta[];
}

interface ParsedSource {
  meta: Omit<CompliancePageMeta, "slug">;
  body: string;
}

const FRONT_MATTER_KEYS = ["title", "description", "updated"] as const;

/**
 * Front matter is three required `key: value` lines between `---` fences.
 * Anything else is a build error, so a typo never publishes a page with an
 * empty title.
 */
export function parseComplianceSource(source: string, label: string): ParsedSource {
  const normalized = source.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`${label}: missing front matter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const field = /^([a-z]+):\s*(.+)$/.exec(line);
    if (!field || !(FRONT_MATTER_KEYS as readonly string[]).includes(field[1] ?? "")) {
      throw new Error(`${label}: unexpected front matter line "${line}"`);
    }
    fields.set(field[1] ?? "", (field[2] ?? "").trim());
  }
  const title = fields.get("title");
  const description = fields.get("description");
  const updated = fields.get("updated");
  if (!title || !description || !updated) {
    throw new Error(`${label}: front matter needs title, description and updated`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(updated) || Number.isNaN(Date.parse(`${updated}T00:00:00Z`))) {
    throw new Error(`${label}: updated must be a YYYY-MM-DD date`);
  }
  return { meta: { title, description, updated }, body: match[2] ?? "" };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dateLabel(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
}

/** The page h1 comes from front matter, so a Markdown h1 renders as h2. */
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
  table: ({ children }) =>
    createElement("div", { className: "table-scroll" }, createElement("table", null, children)),
  img: ({ alt }) =>
    createElement("span", { className: "image-placeholder" }, alt ? `Image: ${alt}` : "Image"),
  a: ({ href, children }) => {
    // react-markdown empties unsafe URLs (javascript: and similar).
    if (typeof href !== "string" || href === "") return createElement("span", null, children);
    const external = /^https?:\/\//i.test(href);
    return createElement(
      "a",
      external ? { href, target: "_blank", rel: "noreferrer" } : { href },
      children
    );
  }
};

export function renderComplianceMarkdown(markdown: string): string {
  return renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm], components: MARKDOWN_COMPONENTS }, markdown)
  );
}

function fillTemplate(template: string, values: Record<string, string>): string {
  const filled = template.replace(/\{\{([A-Z_]+)\}\}/g, (placeholder, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Compliance template has an unknown placeholder ${placeholder}`);
    return value;
  });
  return filled;
}

/** Move the template's single style block to an external stylesheet (CSP: style-src-elem 'self'). */
function externalizeStyle(html: string): { html: string; css: string } {
  const styleBlocks = html.match(/<style>[\s\S]*?<\/style>/g) ?? [];
  const styleMatch = /<style>([\s\S]*?)<\/style>/.exec(html);
  if (styleBlocks.length !== 1 || !styleMatch) {
    throw new Error("The compliance template must contain exactly one embedded style block.");
  }
  if (/<script\b/i.test(html)) {
    throw new Error("Compliance pages must not contain scripts.");
  }
  return {
    html: html.replace(
      styleMatch[0],
      `<link rel="stylesheet" href="${COMPLIANCE_STYLESHEET_HREF}">`
    ),
    css: (styleMatch[1] ?? "").trim()
  };
}

function renderPage(
  template: string,
  meta: Omit<CompliancePageMeta, "slug">,
  eyebrow: string,
  canonicalPath: string,
  content: string
): { html: string; css: string } {
  return externalizeStyle(
    fillTemplate(template, {
      TITLE: escapeHtml(meta.title),
      DESCRIPTION: escapeHtml(meta.description),
      CANONICAL: escapeHtml(`${CANONICAL_ORIGIN}${canonicalPath}`),
      EYEBROW: escapeHtml(eyebrow),
      UPDATED_ISO: escapeHtml(meta.updated),
      UPDATED_LABEL: escapeHtml(dateLabel(meta.updated)),
      CONTENT: content
    })
  );
}

function documentList(documents: CompliancePageMeta[]): string {
  if (documents.length === 0) {
    return '<p class="empty">No public summaries are published yet.</p>';
  }
  const items = documents
    .map(
      (doc) =>
        `<li><a class="doc-link" href="${COMPLIANCE_ROUTE}${doc.slug}/">` +
        `<span class="doc-title">${escapeHtml(doc.title)}</span>` +
        `<span class="doc-description">${escapeHtml(doc.description)}</span>` +
        `<span class="doc-meta">Updated ${escapeHtml(dateLabel(doc.updated))}</span>` +
        "</a></li>"
    )
    .join("\n        ");
  return `<ul class="doc-list">\n        ${items}\n      </ul>`;
}

/**
 * Render every page from `sourceDir`: `template.html`, `index.md` (the index
 * introduction) and one `<slug>.md` per public document.
 */
export async function buildCompliancePages(
  sourceDir: string = COMPLIANCE_SOURCE_DIR
): Promise<CompliancePages> {
  const template = await readFile(path.join(sourceDir, "template.html"), "utf8");
  const entries = (await readdir(sourceDir)).filter((name) => name.endsWith(".md")).sort();
  if (!entries.includes("index.md")) {
    throw new Error(`${sourceDir} must contain index.md`);
  }

  const documents: Array<CompliancePageMeta & { body: string }> = [];
  for (const fileName of entries) {
    if (fileName === "index.md") continue;
    const slug = fileName.slice(0, -".md".length);
    if (slug.length > SLUG_MAX_LENGTH || !COMPLIANCE_SLUG_PATTERN.test(slug) || slug === "index") {
      throw new Error(
        `${fileName}: file names must be lowercase letters, digits and single hyphens`
      );
    }
    const parsed = parseComplianceSource(await readFile(path.join(sourceDir, fileName), "utf8"), fileName);
    documents.push({ slug, ...parsed.meta, body: parsed.body });
  }
  documents.sort((a, b) => a.title.localeCompare(b.title));

  const pages = new Map<string, string>();
  let css = "";
  for (const doc of documents) {
    const content =
      `    <a class="back-link" href="${COMPLIANCE_ROUTE}">All compliance summaries</a>\n` +
      `    <section>\n      <article class="prose">\n${renderComplianceMarkdown(doc.body)}\n      </article>\n    </section>`;
    const rendered = renderPage(template, doc, "Compliance summary", `${COMPLIANCE_ROUTE}${doc.slug}/`, content);
    pages.set(doc.slug, rendered.html);
    css = rendered.css;
  }

  const index = parseComplianceSource(await readFile(path.join(sourceDir, "index.md"), "utf8"), "index.md");
  const metas = documents.map(({ body: _body, ...meta }) => meta);
  const indexContent =
    `    <section>\n      <div class="prose">\n${renderComplianceMarkdown(index.body)}\n      </div>\n    </section>\n` +
    `    <section aria-labelledby="public-summaries">\n      <h2 id="public-summaries">Public summaries</h2>\n      ${documentList(metas)}\n    </section>`;
  const renderedIndex = renderPage(template, index.meta, "Truenote compliance", COMPLIANCE_ROUTE, indexContent);
  css = renderedIndex.css;

  return { css, indexHtml: renderedIndex.html, pages, documents: metas };
}
