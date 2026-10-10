import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { canonicalJson } from "./canonical.js";
import {
  ASSESSMENT_STATEMENT,
  CATALOG_VERSION,
  type CheckDefinition
} from "./catalog.js";

export type CheckResult = "pass" | "fail" | "error";

/** What one check run observed. `failures` explains a fail or error in short lines. */
export interface CheckOutcome {
  result: CheckResult;
  summary: string;
  failures?: string[];
  inputs?: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export interface ReleaseInfo {
  /** Commit the image was built from (.release-commit, written before `railway up`). */
  commit: string | null;
  deploymentId: string | null;
  service: string | null;
}

export interface ReceiptPayload {
  schema: "truenote.evidence-receipt/1";
  checkId: string;
  kind: CheckDefinition["kind"];
  title: string;
  controls: string[];
  objectives: string[];
  catalogVersion: string;
  runId: string | null;
  startedAt: string;
  finishedAt: string;
  result: CheckResult;
  summary: string;
  failures: string[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  attachments: Array<{ key: string; sha256: string; bytes: number; contentType: string }>;
  release: ReleaseInfo;
  statement: string;
}

export interface StoredReceipt {
  id: string;
  sequence: number;
  recordedAt: string;
  receiptHash: string;
}

type SqlExecutor = { execute(query: SQL): Promise<{ rows: unknown[] }> };

const RELEASE_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.release-commit"
);

let releaseCache: ReleaseInfo | undefined;

export function releaseInfo(): ReleaseInfo {
  if (releaseCache) return releaseCache;
  let commit: string | null = null;
  try {
    const text = readFileSync(RELEASE_FILE, "utf8").trim();
    if (/^[0-9a-f]{40}(\+dirty)?$/.test(text)) commit = text;
  } catch {
    // No file: a local run or an image built without the deploy step.
  }
  releaseCache = {
    commit: commit ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID ?? null,
    service: process.env.RAILWAY_SERVICE_NAME ?? process.env.TRUENOTE_PROCESS ?? null
  };
  return releaseCache;
}

export function buildReceiptPayload(
  check: CheckDefinition,
  outcome: CheckOutcome,
  timing: { runId: string | null; startedAt: Date; finishedAt: Date },
  attachments: ReceiptPayload["attachments"] = []
): ReceiptPayload {
  return {
    schema: "truenote.evidence-receipt/1",
    checkId: check.id,
    kind: check.kind,
    title: check.title,
    controls: [...check.controls],
    objectives: [...check.objectives],
    catalogVersion: CATALOG_VERSION,
    runId: timing.runId,
    startedAt: timing.startedAt.toISOString(),
    finishedAt: timing.finishedAt.toISOString(),
    result: outcome.result,
    summary: outcome.summary,
    failures: outcome.failures ?? [],
    inputs: outcome.inputs ?? {},
    outputs: outcome.outputs,
    attachments,
    release: releaseInfo(),
    statement: ASSESSMENT_STATEMENT
  };
}

/** Append through the database function, which assigns time, id and hashes. */
export async function appendReceipt(
  payload: ReceiptPayload,
  executor: SqlExecutor = db as unknown as SqlExecutor
): Promise<StoredReceipt> {
  const result = await executor.execute(sql`
    SELECT id::text AS id, sequence, recorded_at, receipt_hash
    FROM append_evidence_receipt(${canonicalJson(payload)})
  `);
  const row = result.rows[0] as
    | { id?: unknown; sequence?: unknown; recorded_at?: unknown; receipt_hash?: unknown }
    | undefined;
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.recorded_at !== "string" ||
    typeof row.receipt_hash !== "string"
  ) {
    throw new Error("append_evidence_receipt returned an invalid receipt");
  }
  return {
    id: row.id,
    sequence: Number(row.sequence),
    recordedAt: row.recorded_at,
    receiptHash: row.receipt_hash
  };
}
