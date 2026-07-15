import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../lib/db-client.js";
import { appendSecurityEvent } from "../../lib/security/audit.js";
import {
  getMalwareScanningPolicy,
  persistMalwareScanningPolicy,
  scannerConfiguration
} from "../../lib/security/malware-policy.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireSuperUser
} from "../../middleware/current-user.js";

export const securityRouter = Router();

securityRouter.use(
  requireAuth,
  requireFreshPassword,
  requireSuperUser,
  blockDemoWrites
);

const UpdateMalwareScanningBody = z.object({ enabled: z.boolean() });

interface ScanRow {
  version_id: string;
  title: string;
  program_name: string | null;
  lifecycle_state: string;
  scan_status: string;
  scan_findings: unknown;
  scan_completed_at: Date | string | null;
  uploaded_at: Date | string | null;
}

interface ControlEventRow {
  id: string;
  occurred_at: Date | string;
  action: string;
  actor_email: string | null;
  details: unknown;
}

function iso(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

async function dashboardResponse() {
  const [policy, schemaResult, summaryResult, scansResult, eventsResult] = await Promise.all([
    getMalwareScanningPolicy(),
    db.execute(sql`
      SELECT (
        COUNT(*) FILTER (
          WHERE conname IN (
            'document_versions_scan_status_check',
            'document_versions_active_control_check'
          )
          AND pg_get_constraintdef(oid) LIKE '%disabled%'
        ) = 2
      ) AS ready
      FROM pg_constraint
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE lifecycle_state = 'quarantined')::int AS quarantined,
        COUNT(*) FILTER (WHERE scan_status = 'unavailable')::int AS unavailable,
        COUNT(*) FILTER (WHERE scan_status = 'error')::int AS errors,
        COUNT(*) FILTER (WHERE scan_status = 'infected')::int AS infected,
        COUNT(*) FILTER (WHERE scan_status = 'disabled')::int AS disabled
      FROM document_versions
    `),
    db.execute(sql`
      SELECT dv.id::text AS version_id,
             d.title,
             p.name AS program_name,
             dv.lifecycle_state,
             dv.scan_status,
             dv.scan_findings,
             dv.scan_completed_at,
             dv.uploaded_at
      FROM document_versions dv
      JOIN documents d ON d.id = dv.document_id
      LEFT JOIN programs p ON p.id = d.program_id
      WHERE dv.scan_findings <> '[]'::jsonb
         OR dv.scan_status IN ('infected', 'unavailable', 'error', 'disabled')
      ORDER BY COALESCE(dv.scan_completed_at, dv.uploaded_at) DESC
      LIMIT 100
    `),
    db.execute(sql`
      SELECT id::text, occurred_at, action, actor_email, details
      FROM security_events
      WHERE action IN (
        'security.malware_scanning.enabled',
        'security.malware_scanning.disabled'
      )
      ORDER BY occurred_at DESC
      LIMIT 50
    `)
  ]);
  const summary = summaryResult.rows[0] as
    | {
        quarantined?: number;
        unavailable?: number;
        errors?: number;
        infected?: number;
        disabled?: number;
      }
    | undefined;
  const scanner = scannerConfiguration();
  const disabledStatusReady =
    (schemaResult.rows[0] as { ready?: unknown } | undefined)?.ready === true;

  return {
    malwareScanning: {
      ...policy,
      disabledStatusReady,
      scannerConfigured: scanner.configured,
      scannerTransportSecure: scanner.transportSecure
    },
    summary: {
      quarantined: summary?.quarantined ?? 0,
      unavailable: summary?.unavailable ?? 0,
      errors: summary?.errors ?? 0,
      infected: summary?.infected ?? 0,
      disabled: summary?.disabled ?? 0
    },
    scans: (scansResult.rows as unknown as ScanRow[]).map((row) => ({
      versionId: row.version_id,
      title: row.title,
      programName: row.program_name ?? "Unknown program",
      lifecycleState: row.lifecycle_state,
      scanStatus: row.scan_status,
      findings: Array.isArray(row.scan_findings) ? row.scan_findings : [],
      occurredAt: iso(row.scan_completed_at ?? row.uploaded_at)
    })),
    controlEvents: (eventsResult.rows as unknown as ControlEventRow[]).map((row) => ({
      id: row.id,
      occurredAt: iso(row.occurred_at),
      action: row.action,
      actorEmail: row.actor_email,
      details: row.details
    }))
  };
}

securityRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await dashboardResponse());
  } catch (error) {
    next(error);
  }
});

securityRouter.patch("/malware-scanning", async (req, res, next) => {
  const parsed = UpdateMalwareScanningBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Provide the malware-scanning state" });
    return;
  }

  try {
    const user = authedUser(req);
    const enabled = parsed.data.enabled;
    if (!enabled) {
      const readiness = await db.execute(sql`
        SELECT (
          COUNT(*) FILTER (
            WHERE conname IN (
              'document_versions_scan_status_check',
              'document_versions_active_control_check'
            )
            AND pg_get_constraintdef(oid) LIKE '%disabled%'
          ) = 2
        ) AS ready
        FROM pg_constraint
      `);
      if ((readiness.rows[0] as { ready?: unknown } | undefined)?.ready !== true) {
        res.status(503).json({
          error: "Temporary scanner bypass storage is not installed yet"
        });
        return;
      }
    }
    await db.transaction(async (tx) => {
      await persistMalwareScanningPolicy(
        enabled,
        user.id,
        tx as unknown as Parameters<typeof persistMalwareScanningPolicy>[2]
      );
      await appendSecurityEvent(
        {
          action: `security.malware_scanning.${enabled ? "enabled" : "disabled"}`,
          outcome: "success",
          actor: user,
          resourceType: "app_setting",
          resourceId: "malware_scanning",
          details: { enabled }
        },
        tx as unknown as Parameters<typeof appendSecurityEvent>[1]
      );
    });
    res.json(await dashboardResponse());
  } catch (error) {
    next(error);
  }
});
