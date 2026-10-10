/**
 * Upload detailed compliance documents (POA&M, full System Security Plan,
 * 800-53A results) to object storage. These documents describe security
 * weaknesses: keep the source folder outside this repository and never
 * commit it.
 *
 * Usage, by the owner, with the web service's S3 settings injected:
 *   railway run --service web pnpm --filter @workspace/scripts run upload-compliance-docs -- <folder>
 *   ... upload-compliance-docs -- <folder> --dry-run
 *   ... upload-compliance-docs -- <folder> --metadata <file>
 *
 * <folder> holds one `<slug>.md` file per document and `metadata.json`
 * (or the file given with --metadata):
 *   {
 *     "documents": {
 *       "plan-of-action": { "title": "Plan of action and milestones", "version": "1.0", "date": "2026-10-10" }
 *     }
 *   }
 * Every .md file needs a metadata entry and every entry needs a file.
 * Relative paths resolve from the directory the command was started in.
 *
 * Each document goes to compliance/documents/<slug>/<sha256>.md, then
 * compliance/manifest.json is replaced with the new list. The manifest is
 * written last, so readers keep seeing the previous set until every new
 * document is in place. Objects from earlier uploads stay in the bucket but
 * are no longer listed or served.
 *
 * --dry-run lists what would be written and never reads S3 settings. A real
 * run reads them from the environment through getObjectStorage() and never
 * prints them.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPLIANCE_MANIFEST_KEY,
  complianceDocumentKey,
  isComplianceSlug,
  parseComplianceManifest,
  sha256Hex,
  type ComplianceManifest
} from "../../artifacts/api-server/src/lib/compliance/documents.js";
import { getObjectStorage } from "../../artifacts/api-server/src/lib/storage/object-storage.js";

interface MetadataEntry {
  title: string;
  version: string;
  date: string;
}

export interface PlannedObject {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface UploadPlan {
  manifest: ComplianceManifest;
  objects: PlannedObject[];
}

function readMetadata(raw: unknown, label: string): Map<string, MetadataEntry> {
  const documents =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as { documents?: unknown }).documents
      : undefined;
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    throw new Error(`${label} must contain a "documents" object keyed by slug.`);
  }
  const entries = new Map<string, MetadataEntry>();
  for (const [slug, value] of Object.entries(documents as Record<string, unknown>)) {
    const entry = value as Partial<Record<keyof MetadataEntry, unknown>> | null;
    if (
      !entry ||
      typeof entry.title !== "string" ||
      typeof entry.version !== "string" ||
      typeof entry.date !== "string"
    ) {
      throw new Error(`${label}: "${slug}" needs title, version and date as text.`);
    }
    entries.set(slug, { title: entry.title, version: entry.version, date: entry.date });
  }
  return entries;
}

/** Build the objects to write and the manifest that lists them. Reads files only. */
export async function planComplianceUpload(
  folder: string,
  metadataPath = path.join(folder, "metadata.json")
): Promise<UploadPlan> {
  const metadata = readMetadata(
    JSON.parse(await readFile(metadataPath, "utf8")),
    path.basename(metadataPath)
  );
  const files = (await readdir(folder)).filter((name) => name.endsWith(".md")).sort();
  if (files.length === 0) throw new Error("The folder has no .md files.");

  const objects: PlannedObject[] = [];
  const documents: ComplianceManifest["documents"] = [];
  for (const fileName of files) {
    const slug = fileName.slice(0, -".md".length);
    if (!isComplianceSlug(slug)) {
      throw new Error(
        `${fileName}: file names must be lowercase letters, digits and single hyphens.`
      );
    }
    const meta = metadata.get(slug);
    if (!meta) throw new Error(`${fileName} has no entry in the metadata file.`);
    const body = await readFile(path.join(folder, fileName));
    const entry = {
      slug,
      title: meta.title,
      version: meta.version,
      date: meta.date,
      sha256: sha256Hex(body),
      size: body.length
    };
    documents.push(entry);
    objects.push({
      key: complianceDocumentKey(entry),
      body,
      contentType: "text/markdown; charset=utf-8"
    });
  }
  const unused = [...metadata.keys()].filter((slug) => !files.includes(`${slug}.md`));
  if (unused.length > 0) {
    throw new Error(`Metadata lists documents with no file: ${unused.join(", ")}`);
  }

  // The API server validates the same schema on every read.
  const manifest = parseComplianceManifest({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    documents
  });
  objects.push({
    key: COMPLIANCE_MANIFEST_KEY,
    body: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    contentType: "application/json; charset=utf-8"
  });
  return { manifest, objects };
}

interface Args {
  folder: string;
  metadata: string | undefined;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  let folder: string | undefined;
  let metadata: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--metadata") {
      const value = argv[index + 1];
      if (!value) throw new Error("--metadata needs a file path.");
      metadata = path.resolve(baseDir, value);
      index += 1;
    } else if (arg?.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (arg && folder === undefined) folder = path.resolve(baseDir, arg);
    else throw new Error("Give exactly one folder.");
  }
  if (!folder) {
    throw new Error(
      "Usage: upload-compliance-docs -- <folder> [--metadata <file>] [--dry-run]"
    );
  }
  return { folder, metadata, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const plan = await planComplianceUpload(args.folder, args.metadata);
  const count = plan.manifest.documents.length;
  console.log(
    `${args.dryRun ? "Would write" : "Writing"} ${plan.objects.length} objects ` +
      `(${count} ${count === 1 ? "document" : "documents"} and the manifest):`
  );
  for (const object of plan.objects) {
    console.log(`  ${object.key}  ${object.body.length} bytes`);
  }
  if (args.dryRun) {
    console.log("Dry run: nothing was written.");
    return;
  }
  // A missing setting fails here; s3ConfigFromEnv names the variables, never
  // their values.
  const storage = getObjectStorage();
  for (const object of plan.objects) {
    try {
      await storage.put(object.key, object.body, { contentType: object.contentType });
    } catch (error) {
      // Only the error name: SDK messages can include the endpoint or bucket.
      const name = error instanceof Error ? error.name : "unknown error";
      throw new Error(
        `Writing ${object.key} failed (${name}). Documents written before it stay unlisted; ` +
          "the manifest is replaced only after every document is written."
      );
    }
  }
  console.log("Done. The manifest now lists:");
  for (const doc of plan.manifest.documents) {
    console.log(`  ${doc.slug}  version ${doc.version}  ${doc.date}  sha256 ${doc.sha256.slice(0, 12)}`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
