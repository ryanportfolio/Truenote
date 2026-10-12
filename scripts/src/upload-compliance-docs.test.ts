import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { planComplianceUpload } from "./upload-compliance-docs.js";

function folderWith(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "compliance-upload-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  return dir;
}

const METADATA = JSON.stringify({
  documents: {
    "plan-of-action": { title: "Plan of action and milestones", version: "0.1", date: "2026-10-10" }
  }
});

describe("planComplianceUpload", () => {
  it("writes content-addressed documents first and the manifest last", async () => {
    const text = "# Fixture plan\n";
    const dir = folderWith({ "plan-of-action.md": text, "metadata.json": METADATA });
    try {
      const plan = await planComplianceUpload(dir);
      const sha = createHash("sha256").update(text).digest("hex");
      assert.deepEqual(
        plan.objects.map((object) => object.key),
        [`compliance/documents/plan-of-action/${sha}.md`, "compliance/manifest.json"]
      );
      assert.deepEqual(plan.manifest.documents, [
        {
          slug: "plan-of-action",
          title: "Plan of action and milestones",
          version: "0.1",
          date: "2026-10-10",
          sha256: sha,
          size: Buffer.byteLength(text)
        }
      ]);
      const manifest = JSON.parse(plan.objects.at(-1)!.body.toString("utf8"));
      assert.equal(manifest.schemaVersion, 1);
      assert.equal(manifest.documents[0].sha256, sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads a PDF beside its Markdown and lists it in the manifest", async () => {
    const text = "# Fixture plan\n";
    const pdf = "%PDF-1.7\nfixture\n";
    const dir = folderWith({ "plan-of-action.md": text, "plan-of-action.pdf": pdf, "metadata.json": METADATA });
    try {
      const plan = await planComplianceUpload(dir);
      const sha = createHash("sha256").update(text).digest("hex");
      const pdfSha = createHash("sha256").update(pdf).digest("hex");
      assert.deepEqual(
        plan.objects.map((object) => [object.key, object.contentType]),
        [
          [`compliance/documents/plan-of-action/${sha}.md`, "text/markdown; charset=utf-8"],
          [`compliance/documents/plan-of-action/${pdfSha}.pdf`, "application/pdf"],
          ["compliance/manifest.json", "application/json; charset=utf-8"]
        ]
      );
      assert.deepEqual(plan.manifest.documents[0]?.pdf, { sha256: pdfSha, size: Buffer.byteLength(pdf) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a PDF without its Markdown and a file that is not a PDF", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ "plan-of-action.md": "x", "other.pdf": "%PDF-1.7", "metadata.json": METADATA }, /no matching \.md file: other\.pdf/],
      [{ "plan-of-action.md": "x", "plan-of-action.pdf": "<html>", "metadata.json": METADATA }, /is not a PDF file/]
    ];
    for (const [files, expected] of cases) {
      const dir = folderWith(files);
      try {
        await assert.rejects(planComplianceUpload(dir), expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("refuses a file without metadata, metadata without a file, and unsafe names", async () => {
    const cases: Array<[Record<string, string>, RegExp]> = [
      [{ "plan-of-action.md": "x", "other.md": "y", "metadata.json": METADATA }, /other\.md has no entry/],
      [{ "metadata.json": JSON.stringify({ documents: { "plan-of-action": { title: "T", version: "1", date: "2026-10-10" }, extra: { title: "T", version: "1", date: "2026-10-10" } } }), "plan-of-action.md": "x" }, /no file: extra/],
      [{ "Plan_Of_Action.md": "x", "metadata.json": METADATA }, /file names must be lowercase/],
      [{ "plan-of-action.md": "x", "metadata.json": JSON.stringify({ documents: { "plan-of-action": { title: "T", version: "1", date: "10/10/2026" } } }) }, /manifest is invalid at: documents\.0\.date/]
    ];
    for (const [files, expected] of cases) {
      const dir = folderWith(files);
      try {
        await assert.rejects(planComplianceUpload(dir), expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
