import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import {
  AttestationInputError,
  MAX_ATTESTATION_FILE_BYTES,
  MAX_ATTESTATION_FILES,
  MAX_STATEMENT_LENGTH,
  checkAttestationFiles,
  readAttachment,
  recordAttestation
} from "../../lib/evidence/attestations.js";
import { CHECK_RUNNERS } from "../../lib/evidence/runner.js";
import { appendSecurityEvent, recordSecurityEvent } from "../../lib/security/audit.js";
import { evidenceReadLimit, evidenceWriteLimit } from "../../lib/security/route-rate-limit.js";
import {
  ASSESSMENT_STATEMENT,
  CATALOG_VERSION,
  EVIDENCE_CHECKS,
  getCheck
} from "../../lib/evidence/catalog.js";
import nist from "../../lib/evidence/nist-800-53r5-moderate.json" with { type: "json" };
import { enqueueEvidenceRun } from "../../lib/evidence/queue.js";
import { catalogCheckMatch, summaryCounts } from "../../lib/evidence/summary.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";

/**
 * Evidence harness API for the gated compliance pages (super_user only).
 * Contract: docs/security/evidence-api.md. Receipts are read-only here,
 * except attestation uploads, which append one receipt each; the other
 * writes are known-gap links (annotation, audited) and manual runs.
 */
export const evidenceRouter = Router();

evidenceRouter.use(requireAuth, requireFreshPassword, requireSuperUser, blockDemoWrites);

interface ReceiptRow {
  id: string;
  sequence: string | number;
  recorded_at_text: string;
  check_id: string;
  check_kind: string;
  result: "pass" | "fail" | "error";
  run_id: string | null;
  controls: string[];
  objectives: string[];
  payload: string;
  payload_sha256: string;
  previous_hash: string | null;
  receipt_hash: string;
}

function receiptSummary(row: ReceiptRow) {
  const payload = JSON.parse(row.payload) as { summary?: string; failures?: string[]; title?: string };
  return {
    id: row.id,
    sequence: Number(row.sequence),
    recordedAt: row.recorded_at_text,
    checkId: row.check_id,
    kind: row.check_kind,
    title: payload.title ?? getCheck(row.check_id)?.title ?? row.check_id,
    result: row.result,
    runId: row.run_id,
    controls: row.controls,
    objectives: row.objectives,
    summary: payload.summary ?? "",
    failures: payload.failures ?? [],
    receiptHash: row.receipt_hash
  };
}

function receiptDetail(row: ReceiptRow) {
  return {
    ...receiptSummary(row),
    payload: JSON.parse(row.payload) as unknown,
    payloadText: row.payload,
    payloadSha256: row.payload_sha256,
    previousHash: row.previous_hash
  };
}

const RECEIPT_COLUMNS = sql`
  id::text, sequence, recorded_at_text, check_id, check_kind, result, run_id::text,
  controls, objectives, payload, payload_sha256, previous_hash, receipt_hash
`;

/**
 * A receipt counts for a catalog check only under that check's catalog kind,
 * so a receipt naming a catalog check id under another kind is ignored.
 * Receipts whose check id is not in the catalog (retired checks) are kept as
 * they are and attributed to no catalog check.
 */
const ATTRIBUTABLE = sql`(${catalogCheckMatch(EVIDENCE_CHECKS)} OR check_id NOT IN ${EVIDENCE_CHECKS.map((check) => check.id)})`;

async function latestPerCheck(): Promise<ReceiptRow[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (check_id) ${RECEIPT_COLUMNS}
    FROM evidence_receipts
    WHERE ${ATTRIBUTABLE}
    ORDER BY check_id, sequence DESC
  `);
  return result.rows as unknown as ReceiptRow[];
}

evidenceRouter.get("/catalog", evidenceReadLimit, (_req, res) => {
  res.json({
    catalogVersion: CATALOG_VERSION,
    statement: ASSESSMENT_STATEMENT,
    baseline: { title: nist.title, version: nist.version, sha256: nist.sha256, source: nist.source },
    checks: EVIDENCE_CHECKS.map((check) => ({
      ...check,
      controlTitles: Object.fromEntries(
        check.controls.map((control) => [
          control,
          (nist.controls as Record<string, { title: string } | undefined>)[control]?.title ?? null
        ])
      )
    }))
  });
});

evidenceRouter.get("/controls", evidenceReadLimit, async (_req, res, next) => {
  try {
    const latest = new Map((await latestPerCheck()).map((row) => [row.check_id, receiptSummary(row)]));
    const controls = new Map<string, { control: string; title: string | null; checks: unknown[] }>();
    for (const check of EVIDENCE_CHECKS) {
      for (const control of check.controls) {
        const entry = controls.get(control) ?? {
          control,
          title: (nist.controls as Record<string, { title: string } | undefined>)[control]?.title ?? null,
          checks: []
        };
        const receipt = latest.get(check.id);
        entry.checks.push({
          checkId: check.id,
          title: check.title,
          objectives: check.objectives.filter((objective) =>
            ((nist.controls as Record<string, { objectives: string[] } | undefined>)[control]?.objectives ?? []).includes(objective)
          ),
          latest: receipt
            ? { id: receipt.id, result: receipt.result, recordedAt: receipt.recordedAt, summary: receipt.summary }
            : null
        });
        controls.set(control, entry);
      }
    }
    const list = [...controls.values()].map((entry) => {
      const results = (entry.checks as Array<{ latest: { result: string } | null }>).map((c) => c.latest?.result ?? "none");
      const status = results.includes("fail")
        ? "fail"
        : results.includes("error") || results.includes("none")
          ? "incomplete"
          : "pass";
      return { ...entry, status };
    });
    list.sort((a, b) => a.control.localeCompare(b.control, "en", { numeric: true }));
    res.json({ catalogVersion: CATALOG_VERSION, statement: ASSESSMENT_STATEMENT, controls: list });
  } catch (error) {
    next(error);
  }
});

const ReceiptQuery = z.object({
  checkId: z.string().max(100).optional(),
  control: z.string().max(20).optional(),
  result: z.enum(["pass", "fail", "error"]).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

evidenceRouter.get("/receipts", evidenceReadLimit, async (req, res, next) => {
  const parsed = ReceiptQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid receipt query" });
    return;
  }
  const q = parsed.data;
  try {
    const result = await db.execute(sql`
      SELECT ${RECEIPT_COLUMNS}
      FROM evidence_receipts
      WHERE (${q.checkId ?? null}::text IS NULL OR check_id = ${q.checkId ?? null})
        AND (${q.control ?? null}::text IS NULL OR ${q.control ?? null} = ANY(controls))
        AND (${q.result ?? null}::text IS NULL OR result = ${q.result ?? null})
        AND (${q.before ?? null}::bigint IS NULL OR sequence < ${q.before ?? null})
      ORDER BY sequence DESC
      LIMIT ${q.limit}
    `);
    const receipts = (result.rows as unknown as ReceiptRow[]).map(receiptSummary);
    res.json({
      receipts,
      nextBefore: receipts.length === q.limit ? receipts[receipts.length - 1]!.sequence : null
    });
  } catch (error) {
    next(error);
  }
});

evidenceRouter.get("/receipts/:id", evidenceReadLimit, async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: "Invalid receipt id" });
    return;
  }
  try {
    const result = await db.execute(sql`
      SELECT ${RECEIPT_COLUMNS} FROM evidence_receipts WHERE id = ${req.params.id}::uuid
    `);
    const row = result.rows[0] as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }
    res.json(receiptDetail(row));
  } catch (error) {
    next(error);
  }
});

evidenceRouter.get("/failures", evidenceReadLimit, async (_req, res, next) => {
  try {
    const [latest, gaps, lastPass] = await Promise.all([
      latestPerCheck(),
      db.execute(sql`
        SELECT id::text, check_id, poam_id, note, expires_on::text AS expires_on
        FROM evidence_known_gaps WHERE retired_at IS NULL
      `),
      db.execute(sql`
        SELECT check_id, max(sequence) AS last_pass
        FROM evidence_receipts WHERE result = 'pass' AND ${ATTRIBUTABLE} GROUP BY check_id
      `)
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const gapByCheck = new Map<string, Array<Record<string, unknown>>>();
    for (const gap of gaps.rows as Array<{ id: string; check_id: string; poam_id: string; note: string; expires_on: string | null }>) {
      const list = gapByCheck.get(gap.check_id) ?? [];
      list.push({
        id: gap.id,
        poamId: gap.poam_id,
        note: gap.note,
        expiresOn: gap.expires_on,
        expired: gap.expires_on !== null && gap.expires_on < today
      });
      gapByCheck.set(gap.check_id, list);
    }
    const passByCheck = new Map(
      (lastPass.rows as Array<{ check_id: string; last_pass: string | number }>).map((row) => [row.check_id, Number(row.last_pass)])
    );
    const failing = latest
      .filter((row) => row.result !== "pass")
      .map((row) => {
        const knownGaps = gapByCheck.get(row.check_id) ?? [];
        return {
          ...receiptSummary(row),
          lastPassSequence: passByCheck.get(row.check_id) ?? null,
          knownGaps,
          tracked: row.result === "fail" && knownGaps.some((gap) => gap.expired === false)
        };
      });
    res.json({ statement: ASSESSMENT_STATEMENT, failures: failing });
  } catch (error) {
    next(error);
  }
});

evidenceRouter.get("/chain", evidenceReadLimit, async (_req, res, next) => {
  try {
    const head = await db.execute(sql`
      SELECT count(*) AS total, max(sequence) AS head_sequence,
             (array_agg(receipt_hash ORDER BY sequence DESC))[1] AS head_hash,
             min(recorded_at_text) AS first_recorded_at,
             max(recorded_at_text) AS last_recorded_at
      FROM evidence_receipts
    `);
    const integrity = await db.execute(sql`
      SELECT DISTINCT ON (check_id) ${RECEIPT_COLUMNS}
      FROM evidence_receipts
      WHERE ${catalogCheckMatch(EVIDENCE_CHECKS.filter((check) => check.kind === "integrity"))}
      ORDER BY check_id, sequence DESC
    `);
    const row = head.rows[0] as Record<string, unknown>;
    res.json({
      total: Number(row.total ?? 0),
      headSequence: row.head_sequence === null ? null : Number(row.head_sequence),
      headHash: (row.head_hash as string | null) ?? null,
      firstRecordedAt: (row.first_recorded_at as string | null) ?? null,
      lastRecordedAt: (row.last_recorded_at as string | null) ?? null,
      hashRule:
        "receipt_hash = sha256(previous_hash || '|' || id || '|' || recorded_at_text || '|' || sha256(payload)); previous_hash '' for the first receipt",
      integrity: (integrity.rows as unknown as ReceiptRow[]).map(receiptDetail)
    });
  } catch (error) {
    next(error);
  }
});

// Monthly summaries (summary.ts), newest first; counts total the checks by latest result.
evidenceRouter.get("/summaries", evidenceReadLimit, async (_req, res, next) => {
  try {
    const result = await db.execute(sql`
      SELECT id::text, sequence, recorded_at_text, receipt_hash, payload
      FROM evidence_receipts
      WHERE ${catalogCheckMatch(EVIDENCE_CHECKS.filter((check) => check.kind === "summary"))}
      ORDER BY sequence DESC
    `);
    const summaries = (
      result.rows as Array<{ id: string; sequence: string | number; recorded_at_text: string; receipt_hash: string; payload: string }>
    ).map((row) => {
      const payload = JSON.parse(row.payload) as { inputs?: { month?: unknown }; outputs?: { chainHead?: unknown } };
      return {
        id: row.id,
        sequence: Number(row.sequence),
        recordedAt: row.recorded_at_text,
        month: typeof payload.inputs?.month === "string" ? payload.inputs.month : null,
        receiptHash: row.receipt_hash,
        chainHead: payload.outputs?.chainHead ?? null,
        counts: summaryCounts(payload.outputs)
      };
    });
    res.json({ statement: ASSESSMENT_STATEMENT, summaries });
  } catch (error) {
    next(error);
  }
});

evidenceRouter.get("/gaps", evidenceReadLimit, async (_req, res, next) => {
  try {
    const result = await db.execute(sql`
      SELECT id::text, check_id, poam_id, note, expires_on::text AS expires_on,
             created_at, created_by::text, retired_at, retired_by::text
      FROM evidence_known_gaps
      ORDER BY retired_at IS NOT NULL, created_at DESC
    `);
    res.json({
      gaps: (result.rows as Array<Record<string, unknown>>).map((row) => ({
        id: row.id,
        checkId: row.check_id,
        poamId: row.poam_id,
        note: row.note,
        expiresOn: row.expires_on,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        createdBy: row.created_by,
        retiredAt: row.retired_at instanceof Date ? row.retired_at.toISOString() : row.retired_at,
        retiredBy: row.retired_by
      }))
    });
  } catch (error) {
    next(error);
  }
});

const CreateGapBody = z.object({
  checkId: z.string().refine((id) => getCheck(id) !== undefined, "Unknown check"),
  poamId: z.string().trim().min(1).max(64),
  note: z.string().max(2000).default(""),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null)
});

evidenceRouter.post("/gaps", evidenceWriteLimit, async (req, res, next) => {
  const parsed = CreateGapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide checkId, poamId and optional note and expiresOn (YYYY-MM-DD)" });
    return;
  }
  try {
    const user = authedUser(req);
    const gap = parsed.data;
    const id = await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO evidence_known_gaps (check_id, poam_id, note, expires_on, created_by)
        VALUES (${gap.checkId}, ${gap.poamId}, ${gap.note}, ${gap.expiresOn}::date, ${user.id}::uuid)
        RETURNING id::text
      `);
      const gapId = (inserted.rows[0] as { id: string }).id;
      await appendSecurityEvent(
        {
          action: "evidence.known_gap.created",
          outcome: "success",
          actor: user,
          resourceType: "evidence_known_gap",
          resourceId: gapId,
          details: { checkId: gap.checkId, poamId: gap.poamId, expiresOn: gap.expiresOn }
        },
        tx as unknown as Parameters<typeof appendSecurityEvent>[1]
      );
      return gapId;
    });
    res.status(201).json({ id });
  } catch (error) {
    if ((error as { cause?: { code?: string } })?.cause?.code === "23505") {
      res.status(409).json({ error: "An active link for this check and POA&M item already exists" });
      return;
    }
    next(error);
  }
});

evidenceRouter.post("/gaps/:id/retire", evidenceWriteLimit, async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: "Invalid gap id" });
    return;
  }
  try {
    const user = authedUser(req);
    const retired = await db.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        UPDATE evidence_known_gaps
        SET retired_at = now(), retired_by = ${user.id}::uuid
        WHERE id = ${req.params.id}::uuid AND retired_at IS NULL
        RETURNING check_id, poam_id
      `);
      const row = updated.rows[0] as { check_id: string; poam_id: string } | undefined;
      if (!row) return false;
      await appendSecurityEvent(
        {
          action: "evidence.known_gap.retired",
          outcome: "success",
          actor: user,
          resourceType: "evidence_known_gap",
          resourceId: req.params.id,
          details: { checkId: row.check_id, poamId: row.poam_id }
        },
        tx as unknown as Parameters<typeof appendSecurityEvent>[1]
      );
      return true;
    });
    if (!retired) {
      res.status(404).json({ error: "No active gap link with that id" });
      return;
    }
    res.json({ retired: true });
  } catch (error) {
    next(error);
  }
});

// Attestation checks have no runner; a run of one would only record an error receipt.
const RunBody = z.object({
  checkIds: z
    .array(z.string().refine((id) => getCheck(id) !== undefined && CHECK_RUNNERS[id] !== undefined, "Unknown automated check"))
    .max(50)
    .optional()
});

evidenceRouter.post("/runs", evidenceWriteLimit, async (req, res, next) => {
  const parsed = RunBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "checkIds must be known automated check ids" });
    return;
  }
  try {
    const user = authedUser(req);
    const jobId = await enqueueEvidenceRun({ trigger: "manual", ...(parsed.data.checkIds ? { checkIds: parsed.data.checkIds } : {}) });
    await appendSecurityEvent({
      action: "evidence.run.requested",
      outcome: "success",
      actor: user,
      resourceType: "evidence_run",
      resourceId: jobId,
      details: { checkIds: parsed.data.checkIds ?? "all", queued: jobId !== null }
    });
    res.status(202).json({ queued: jobId !== null, jobId });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------- attestations

/**
 * Attestation files are parsed into memory: at most 10 files of 20 MiB in the
 * field `files`, one short text field `statement`. fieldArrayIndexLimit 0
 * refuses names like `statement[4294967294]` (GHSA-535w-7cp7-47q4).
 */
const attestationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_ATTESTATION_FILE_BYTES,
    files: MAX_ATTESTATION_FILES,
    fields: 5,
    fieldSize: 16 * 1024,
    fieldNameSize: 100,
    parts: MAX_ATTESTATION_FILES + 5,
    fieldArrayIndexLimit: 0
  }
}).array("files", MAX_ATTESTATION_FILES);

/** Multer and malformed-body errors become 413 or 400, never 500. */
function parseAttestationUpload(req: Request, res: Response, next: NextFunction): void {
  attestationUpload(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      const tooLarge = error.code === "LIMIT_FILE_SIZE";
      const tooMany = error.code === "LIMIT_FILE_COUNT" || (error.code === "LIMIT_UNEXPECTED_FILE" && error.field === "files");
      res.status(tooLarge || tooMany ? 413 : 400).json({
        error: tooLarge
          ? "Files are limited to 20 MiB each."
          : tooMany
            ? `Attach at most ${MAX_ATTESTATION_FILES} files.`
            : `Upload refused: ${error.message}`
      });
      return;
    }
    res.status(400).json({ error: "Send multipart/form-data with the field files and the field statement." });
  });
}

const AttestationStatement = z.string().trim().min(1).max(MAX_STATEMENT_LENGTH);

evidenceRouter.post(
  "/attestations/:checkId",
  evidenceWriteLimit,
  (req, res, next) => {
    const check = getCheck(req.params.checkId ?? "");
    if (!check) {
      res.status(404).json({ error: "Unknown check" });
      return;
    }
    if (check.kind !== "attestation") {
      res.status(400).json({ error: "This check is automated; only attestation checks accept uploads" });
      return;
    }
    next();
  },
  parseAttestationUpload,
  async (req, res, next) => {
    const startedAt = new Date();
    const check = getCheck(req.params.checkId ?? "")!;
    const statement = AttestationStatement.safeParse(req.body?.statement);
    if (!statement.success) {
      res.status(400).json({ error: `Add a statement of what the files show (1 to ${MAX_STATEMENT_LENGTH} characters).` });
      return;
    }
    let files;
    try {
      files = checkAttestationFiles(Array.isArray(req.files) ? req.files : []);
    } catch (error) {
      if (error instanceof AttestationInputError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }
    try {
      const user = authedUser(req);
      const recorded = await recordAttestation({
        check,
        files,
        statement: statement.data,
        user,
        startedAt
      });
      res.status(201).json({
        receipt: {
          id: recorded.receipt.id,
          sequence: recorded.receipt.sequence,
          recordedAt: recorded.receipt.recordedAt,
          receiptHash: recorded.receipt.receiptHash
        },
        attachments: recorded.attachments
      });
    } catch (error) {
      next(error);
    }
  }
);

evidenceRouter.get("/receipts/:id/attachments/:index", evidenceReadLimit, async (req, res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    res.status(400).json({ error: "Invalid receipt id" });
    return;
  }
  const index = /^\d{1,4}$/.test(req.params.index ?? "") ? Number(req.params.index) : -1;
  try {
    const read = await readAttachment(req.params.id ?? "", index);
    if (read.status === "not-found") {
      res.status(404).json({ error: "No such receipt attachment" });
      return;
    }
    if (read.status !== "ok") {
      await recordSecurityEvent({
        action: "evidence.attestation.attachment_check",
        outcome: "failure",
        actor: authedUser(req),
        resourceType: "evidence_receipt",
        resourceId: req.params.id,
        details: { index, key: read.key, reason: read.status, expectedSha256: read.expected, actualSha256: read.actual }
      }).catch(() => undefined); // appendSecurityEvent already logged and alerted
      res.status(409).json({
        error:
          read.status === "missing"
            ? "The stored file is missing; it no longer matches the receipt."
            : "The stored file does not match the sha256 in the receipt; it is not served."
      });
      return;
    }
    res.setHeader("Content-Type", read.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${read.fileName}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).end(read.data);
  } catch (error) {
    next(error);
  }
});
