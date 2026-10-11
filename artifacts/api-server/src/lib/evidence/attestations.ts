import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { CurrentUser } from "../auth/current-user.js";
import { db } from "../db-client.js";
import { appendSecurityEvent } from "../security/audit.js";
import { getObjectStorage } from "../storage/object-storage.js";
import { EVIDENCE_CHECKS, type Cadence, type CheckDefinition } from "./catalog.js";
import { ATTESTATION_LINE_PREFIX, queueAndSendLines } from "./notify.js";
import { appendReceipt, buildReceiptPayload, type ReceiptPayload, type StoredReceipt } from "./receipts.js";

/**
 * Attestations (docs/security/evidence-harness.md, phase 3): proof the owner
 * supplies (screenshots, reports), uploaded by a super_user, stored in the
 * bucket under evidence/attestations/ and bound to a receipt of kind
 * attestation by the sha256 of each file. The daily run reminds the owner by
 * email once per due period; it never runs an attestation check.
 */

type Executor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

/** Days after the latest pass at which an attestation is due again, by cadence. */
export const ATTESTATION_PERIOD_DAYS: Record<Exclude<Cadence, "daily">, number> = {
  monthly: 31,
  quarterly: 92,
  annual: 366
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function attestationChecks(): CheckDefinition[] {
  return EVIDENCE_CHECKS.filter((check) => check.kind === "attestation");
}

function periodDays(check: CheckDefinition): number {
  return check.cadence === "daily" ? 1 : ATTESTATION_PERIOD_DAYS[check.cadence];
}

export interface DueAttestation {
  checkId: string;
  /** Latest pass receipt time, null when the check was never attested. */
  lastPassAt: string | null;
  /** lastPassAt plus the cadence's period, null when never attested. */
  dueSince: string | null;
}

/**
 * Attestation checks that are due at `now`: never attested (no or a null
 * entry in `latestPass`), or attested at least the cadence's period ago.
 */
export function dueAttestations(now: Date, latestPass: Record<string, string | null>): DueAttestation[] {
  const due: DueAttestation[] = [];
  for (const check of attestationChecks()) {
    const last = latestPass[check.id] ?? null;
    const lastMs = last === null ? NaN : Date.parse(last);
    if (Number.isNaN(lastMs)) {
      due.push({ checkId: check.id, lastPassAt: null, dueSince: null });
      continue;
    }
    const dueAt = lastMs + periodDays(check) * DAY_MS;
    if (now.getTime() >= dueAt) {
      due.push({ checkId: check.id, lastPassAt: last, dueSince: new Date(dueAt).toISOString() });
    }
  }
  return due;
}

const ATTESTATION_ROUTE = "POST /api/admin/evidence/attestations/";

/** What the owner uploads, by check id; the full rule is the check's passCondition. */
const WHAT_TO_UPLOAD: Record<string, string> = {
  "attestation.operator-mfa":
    "screenshots of the MFA settings of every operator account (hosting, source control, identity provider, DNS, alert mailbox)",
  "attestation.workstation-patch-malware":
    "the OS update status and anti-malware status (protection on, signature date, last scan) of each admin workstation",
  "attestation.access-review":
    "the account and privilege review record (accounts, roles, kept, changed or removed)",
  "attestation.policy-review":
    "the review record of the security policies, system security plan, incident response plan and contingency plan"
};

function reminderKey(entry: DueAttestation): string {
  return entry.dueSince ?? "never";
}

/**
 * One reminder line per due check whose due period was not reminded yet.
 * `remembered` maps a check id to the key of the period last reminded
 * (dueSince, or "never"); the returned map holds the key of every check due
 * now, so a check attested since drops out and is reminded again when its
 * next period starts.
 */
export function planAttestationReminders(
  due: DueAttestation[],
  remembered: Record<string, string>
): { lines: string[]; remembered: Record<string, string> } {
  const lines: string[] = [];
  const next: Record<string, string> = {};
  for (const entry of due) {
    const key = reminderKey(entry);
    next[entry.checkId] = key;
    if (remembered[entry.checkId] === key) continue;
    const check = attestationChecks().find((c) => c.id === entry.checkId);
    const what = WHAT_TO_UPLOAD[entry.checkId] ?? check?.title ?? "the proof the check's pass condition names";
    const since = entry.lastPassAt
      ? `last attested ${entry.lastPassAt}, due since ${entry.dueSince}`
      : "never attested";
    lines.push(
      `${ATTESTATION_LINE_PREFIX}: ${entry.checkId} (${check?.cadence ?? "unknown cadence"}, ${since}). ` +
        `Upload ${what} with a statement of what the files show: ${ATTESTATION_ROUTE}${entry.checkId} ` +
        `(super_user, multipart: files, statement).`
    );
  }
  return { lines, remembered: next };
}

// ---------------------------------------------------------------- reminders in the daily run

const REMINDERS_KEY = "evidence_attestation_reminders";

async function latestAttestationPasses(): Promise<Record<string, string | null>> {
  const ids = attestationChecks().map((check) => check.id);
  if (ids.length === 0) return {};
  const result = await db.execute(sql`
    SELECT check_id,
           to_char(max(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_pass_at
    FROM evidence_receipts
    WHERE check_kind = 'attestation' AND result = 'pass' AND check_id IN ${ids}
    GROUP BY check_id
  `);
  return Object.fromEntries(
    (result.rows as Array<{ check_id: string; last_pass_at: string | null }>).map((row) => [row.check_id, row.last_pass_at])
  );
}

async function readRemembered(): Promise<Record<string, string>> {
  const result = await db.execute(sql`SELECT value FROM app_settings WHERE key = ${REMINDERS_KEY}`);
  const checks = (result.rows[0] as { value?: { checks?: unknown } } | undefined)?.value?.checks;
  if (!checks || typeof checks !== "object" || Array.isArray(checks)) return {};
  return Object.fromEntries(
    Object.entries(checks as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

async function writeRemembered(remembered: Record<string, string>, executor: Executor): Promise<void> {
  const value = JSON.stringify({ checks: remembered, updatedAt: new Date().toISOString() });
  await executor.execute(sql`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (${REMINDERS_KEY}, ${value}::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `);
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => b[key] === a[key]);
}

/**
 * Called by the daily run after its alert email. New reminder lines join the
 * pending evidence alert lines (notify.ts) in the same transaction that saves
 * the remembered map, then every pending line is sent; a failed send leaves
 * them pending for the next run. Returns the number of new lines.
 */
export async function remindDueAttestations(now = new Date()): Promise<number> {
  const due = dueAttestations(now, await latestAttestationPasses());
  const remembered = await readRemembered();
  const plan = planAttestationReminders(due, remembered);
  if (plan.lines.length > 0) {
    await queueAndSendLines(plan.lines, (tx) => writeRemembered(plan.remembered, tx));
  } else if (!sameMap(plan.remembered, remembered)) {
    await writeRemembered(plan.remembered, db as unknown as Executor);
  }
  return plan.lines.length;
}

// ---------------------------------------------------------------- upload

export const MAX_ATTESTATION_FILES = 10;
export const MAX_ATTESTATION_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_STATEMENT_LENGTH = 2000;

interface AllowedType {
  contentType: string;
  /** Leading bytes the file must start with; null for text types. */
  magic: Buffer | null;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from("%PDF-", "latin1");

/** Allowed file types by extension; the declared type must match. */
const ALLOWED_TYPES: Record<string, AllowedType> = {
  ".png": { contentType: "image/png", magic: PNG_MAGIC },
  ".jpg": { contentType: "image/jpeg", magic: JPEG_MAGIC },
  ".jpeg": { contentType: "image/jpeg", magic: JPEG_MAGIC },
  ".pdf": { contentType: "application/pdf", magic: PDF_MAGIC },
  ".txt": { contentType: "text/plain", magic: null },
  ".csv": { contentType: "text/csv", magic: null }
};

export const ALLOWED_ATTESTATION_CONTENT_TYPES = new Set(
  Object.values(ALLOWED_TYPES).map((type) => type.contentType)
);

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  buffer: Buffer;
  size: number;
}

export interface CheckedFile {
  name: string;
  extension: string;
  contentType: string;
  data: Buffer;
  sha256: string;
}

/** Keep the base name only, letters, digits, dot, dash, underscore and space; at most 120 characters. */
export function sanitizeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+/, "")
    .trim()
    .slice(-120);
  return clean.length > 0 ? clean : fallback;
}

function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(name.trim());
  return match ? match[0].toLowerCase() : "";
}

export class AttestationInputError extends Error {}

/**
 * Validate every file before anything is stored: allowed extension, a
 * declared type matching it, the leading bytes for png, jpeg and pdf, size
 * within the limit. Throws AttestationInputError naming the first refusal.
 */
export function checkAttestationFiles(files: UploadedFile[]): CheckedFile[] {
  if (files.length === 0) throw new AttestationInputError("Attach at least one file in the field files.");
  if (files.length > MAX_ATTESTATION_FILES) {
    throw new AttestationInputError(`Attach at most ${MAX_ATTESTATION_FILES} files.`);
  }
  return files.map((file, index) => {
    const extension = extensionOf(file.originalname);
    const allowed = ALLOWED_TYPES[extension];
    const label = `File ${index + 1}`;
    if (!allowed) {
      throw new AttestationInputError(`${label}: only .png, .jpg, .jpeg, .pdf, .txt and .csv files are accepted.`);
    }
    const declared = file.mimetype.split(";")[0]!.trim().toLowerCase();
    if (declared !== allowed.contentType) {
      throw new AttestationInputError(`${label}: a ${extension} file must be sent as ${allowed.contentType}.`);
    }
    if (file.buffer.length === 0) throw new AttestationInputError(`${label}: the file is empty.`);
    if (file.buffer.length > MAX_ATTESTATION_FILE_BYTES) {
      throw new AttestationInputError(`${label}: files are limited to 20 MiB.`);
    }
    if (allowed.magic && !file.buffer.subarray(0, allowed.magic.length).equals(allowed.magic)) {
      throw new AttestationInputError(`${label}: the content is not a ${allowed.contentType} file.`);
    }
    return {
      name: sanitizeFileName(file.originalname, `file-${index}${extension}`),
      extension,
      contentType: allowed.contentType,
      data: file.buffer,
      sha256: createHash("sha256").update(file.buffer).digest("hex")
    };
  });
}

export interface RecordedAttestation {
  receipt: StoredReceipt;
  attachments: ReceiptPayload["attachments"];
}

/**
 * Store each file under evidence/attestations/<checkId>/<uuid>/, then append
 * one attestation receipt (result pass, the owner's statement) and its
 * security event in one transaction. Objects already stored are deleted,
 * best effort, when a later step fails.
 */
export async function recordAttestation(input: {
  check: CheckDefinition;
  files: CheckedFile[];
  statement: string;
  user: Pick<CurrentUser, "id" | "email" | "role">;
  startedAt: Date;
}): Promise<RecordedAttestation> {
  const { check, files, statement, user } = input;
  const storage = getObjectStorage();
  const upload = randomUUID();
  const attachments: ReceiptPayload["attachments"] = files.map((file, index) => ({
    key: `evidence/attestations/${check.id}/${upload}/${index}-${file.sha256.slice(0, 16)}${file.extension}`,
    sha256: file.sha256,
    bytes: file.data.length,
    contentType: file.contentType
  }));
  const stored: string[] = [];
  try {
    for (const [index, file] of files.entries()) {
      const key = attachments[index]!.key;
      await storage.put(key, file.data, { contentType: file.contentType });
      stored.push(key);
    }
    const payload = buildReceiptPayload(
      check,
      {
        result: "pass",
        summary: `Attested by ${user.email} with ${files.length} file(s).`,
        inputs: {
          statement,
          uploadedBy: { id: user.id, email: user.email },
          fileNames: files.map((file) => file.name)
        },
        outputs: {
          files: files.length,
          totalBytes: files.reduce((sum, file) => sum + file.data.length, 0)
        }
      },
      { runId: null, startedAt: input.startedAt, finishedAt: new Date() },
      attachments
    );
    const receipt = await db.transaction(async (tx) => {
      const appended = await appendReceipt(payload, tx as unknown as Executor);
      await appendSecurityEvent(
        {
          action: "evidence.attestation.recorded",
          outcome: "success",
          actor: user,
          resourceType: "evidence_receipt",
          resourceId: appended.id,
          details: {
            checkId: check.id,
            receiptSequence: appended.sequence,
            attachments: attachments.map((a) => ({ key: a.key, sha256: a.sha256, bytes: a.bytes }))
          }
        },
        tx as unknown as Parameters<typeof appendSecurityEvent>[1]
      );
      return appended;
    });
    return { receipt, attachments };
  } catch (error) {
    await Promise.all(stored.map((key) => storage.delete(key).catch(() => undefined)));
    throw error;
  }
}

// ---------------------------------------------------------------- download

export type AttachmentRead =
  | { status: "not-found" }
  | { status: "ok"; data: Buffer; contentType: string; fileName: string }
  | { status: "missing" | "mismatch"; key: string; expected: string; actual: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isAttachment(value: unknown): value is ReceiptPayload["attachments"][number] {
  const a = value as Partial<ReceiptPayload["attachments"][number]> | null;
  return (
    !!a &&
    typeof a.key === "string" &&
    a.key.startsWith("evidence/") &&
    typeof a.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(a.sha256) &&
    typeof a.contentType === "string"
  );
}

/**
 * Read attachment `index` of receipt `receiptId` and check its sha256
 * against the receipt. The bytes are returned only on a match.
 */
export async function readAttachment(receiptId: string, index: number): Promise<AttachmentRead> {
  if (!UUID_RE.test(receiptId) || !Number.isSafeInteger(index) || index < 0) return { status: "not-found" };
  const result = await db.execute(sql`SELECT payload FROM evidence_receipts WHERE id = ${receiptId}::uuid`);
  const row = result.rows[0] as { payload?: string } | undefined;
  if (!row?.payload) return { status: "not-found" };
  const payload = JSON.parse(row.payload) as { attachments?: unknown; inputs?: { fileNames?: unknown } };
  const list = Array.isArray(payload.attachments) ? payload.attachments : [];
  const attachment = list[index];
  if (!isAttachment(attachment)) return { status: "not-found" };

  const storage = getObjectStorage();
  let data: Buffer;
  try {
    data = await storage.get(attachment.key);
  } catch (error) {
    if (await storage.exists(attachment.key)) throw error;
    return { status: "missing", key: attachment.key, expected: attachment.sha256, actual: null };
  }
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== attachment.sha256) {
    return { status: "mismatch", key: attachment.key, expected: attachment.sha256, actual };
  }
  const contentType = ALLOWED_ATTESTATION_CONTENT_TYPES.has(attachment.contentType)
    ? attachment.contentType
    : "application/octet-stream";
  const names = Array.isArray(payload.inputs?.fileNames) ? payload.inputs.fileNames : [];
  const recorded = names[index];
  const fallback = `attachment-${index}${extensionOf(attachment.key)}`;
  const fileName = sanitizeFileName(typeof recorded === "string" ? recorded : "", fallback);
  return { status: "ok", data, contentType, fileName };
}
