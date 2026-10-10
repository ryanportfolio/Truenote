/**
 * Detailed compliance documents (POA&M, full System Security Plan, 800-53A
 * results). They describe security weaknesses, so they never live in the
 * public repository: the owner uploads them to object storage with
 * scripts/src/upload-compliance-docs.ts, and /api/compliance serves them to
 * super users only.
 *
 * Storage layout, all under the `compliance/` prefix:
 *   compliance/manifest.json                     the list of documents
 *   compliance/documents/<slug>/<sha256>.md      one object per version
 *
 * Content-addressed document keys let the upload script write every document
 * before it switches the manifest, so a reader never sees a manifest entry
 * whose object has not been written yet.
 *
 * Storage keys are only ever built from a parsed manifest entry, whose slug
 * and sha256 passed the patterns below. Request input selects an entry by
 * exact slug match; it never reaches a key directly.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { getObjectStorage, type ObjectStorage } from "../storage/object-storage.js";

export const COMPLIANCE_KEY_PREFIX = "compliance/";
export const COMPLIANCE_MANIFEST_KEY = `${COMPLIANCE_KEY_PREFIX}manifest.json`;
export const COMPLIANCE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COMPLIANCE_SLUG_MAX_LENGTH = 80;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DOCUMENTS = 200;

export function isComplianceSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= COMPLIANCE_SLUG_MAX_LENGTH &&
    COMPLIANCE_SLUG_PATTERN.test(value)
  );
}

const ManifestEntrySchema = z
  .object({
    slug: z.string().refine(isComplianceSlug, "Invalid slug"),
    title: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(40),
    date: z.string().regex(DATE_PATTERN),
    sha256: z.string().regex(SHA256_PATTERN),
    size: z.number().int().nonnegative()
  })
  .strict();

const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().max(40).optional(),
    documents: z.array(ManifestEntrySchema).max(MAX_DOCUMENTS)
  })
  .strict()
  .refine(
    (manifest) =>
      new Set(manifest.documents.map((entry) => entry.slug)).size ===
      manifest.documents.length,
    "Each slug may appear only once"
  );

export type ComplianceManifestEntry = z.infer<typeof ManifestEntrySchema>;
export type ComplianceManifest = z.infer<typeof ManifestSchema>;

export class ComplianceManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplianceManifestError";
  }
}

export class ComplianceIntegrityError extends Error {
  constructor(readonly slug: string) {
    super(`Compliance document ${slug} does not match its manifest hash`);
    this.name = "ComplianceIntegrityError";
  }
}

export function parseComplianceManifest(raw: unknown): ComplianceManifest {
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    // Field paths only: the manifest is ours, but its values stay out of logs.
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || "(root)")
      .join(", ");
    throw new ComplianceManifestError(`Compliance manifest is invalid at: ${fields}`);
  }
  return parsed.data;
}

export function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Storage key for one document version. Rejects anything but a validated entry. */
export function complianceDocumentKey(
  entry: Pick<ComplianceManifestEntry, "slug" | "sha256">
): string {
  if (!isComplianceSlug(entry.slug) || !SHA256_PATTERN.test(entry.sha256)) {
    throw new ComplianceManifestError("Refusing to build a key from an invalid entry");
  }
  return `${COMPLIANCE_KEY_PREFIX}documents/${entry.slug}/${entry.sha256}.md`;
}

/** The manifest, or an empty list when nothing has been uploaded yet. */
export async function readComplianceManifest(
  storage: ObjectStorage = getObjectStorage()
): Promise<ComplianceManifest> {
  if (!(await storage.exists(COMPLIANCE_MANIFEST_KEY))) {
    return { schemaVersion: 1, documents: [] };
  }
  const body = await storage.get(COMPLIANCE_MANIFEST_KEY);
  let raw: unknown;
  try {
    raw = JSON.parse(body.toString("utf8"));
  } catch {
    throw new ComplianceManifestError("Compliance manifest is not valid JSON");
  }
  return parseComplianceManifest(raw);
}

/** Read one document's Markdown and check it against the manifest hash. */
export async function readComplianceDocumentBody(
  entry: ComplianceManifestEntry,
  storage: ObjectStorage = getObjectStorage()
): Promise<string> {
  const body = await storage.get(complianceDocumentKey(entry));
  if (sha256Hex(body) !== entry.sha256) {
    throw new ComplianceIntegrityError(entry.slug);
  }
  return body.toString("utf8");
}
