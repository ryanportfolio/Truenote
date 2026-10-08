import { Router, type NextFunction, type Request, type Response } from "express";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../../lib/db-client.js";
import {
  authedUser,
  blockDemoWrites,
  requireAuth,
  requireFreshPassword,
  requireManagerOrAbove,
  requireRole
} from "../../middleware/current-user.js";
import { canAccessProgram } from "../../lib/auth/current-user.js";
import { resolveEffectiveProgramId } from "../../lib/auth/effective-program.js";
import { clientIpFrom } from "../../lib/auth/rate-limit.js";
import { uuidArray } from "../../lib/kb-library-sql.js";
import { appendSecurityEvent } from "../../lib/security/audit.js";
import { teamsReadLimit, teamsWriteLimit } from "../../lib/security/route-rate-limit.js";
import { assignmentBodySchema } from "../../lib/teams.js";

/**
 * Supervisor teams, per program. Rows live in team_members (raw SQL,
 * lib/db/sql/0005_team_members.sql); a CSR is on at most one team.
 *
 *   GET /             supervisor and above. Manager and above see every
 *                     active supervisor and CSR in the program; a
 *                     supervisor sees only themselves and their own CSRs.
 *   PUT /assignments  manager and above, not demo accounts. Moves CSRs onto
 *                     a supervisor's team, or off every team when
 *                     supervisorId is null.
 *
 * Only active users are listed. The DB guard trigger refuses a row whose
 * CSR or supervisor has the wrong role or program; the PUT handler checks
 * the same thing first, under row locks, so a bad request gets a 400 with
 * nothing written.
 */

export interface TeamsSupervisor {
  id: string;
  name: string;
  email: string;
}

export interface TeamsCsr {
  id: string;
  name: string;
  email: string;
  lastLoginAt: string | null;
  supervisorId: string | null;
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

export const teamsRouter = Router();

teamsRouter.use(requireAuth, requireFreshPassword, requireRole("supervisor"));

async function programFor(req: Request, res: Response): Promise<string | null> {
  const user = authedUser(req);
  const programId = await resolveEffectiveProgramId(user, req);
  if (programId === null) {
    res.status(400).json({ error: "No program selected." });
    return null;
  }
  if (!canAccessProgram(user, programId)) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return programId;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Active CSRs in the program with their supervisor. `supervisorId` is null
 * unless the assignment points at an active supervisor in the same program,
 * so the list never names someone the supervisor list leaves out. Pass
 * `onlySupervisorId` to keep just that supervisor's team.
 */
async function listCsrs(
  executor: SqlExecutor,
  programId: string,
  onlySupervisorId: string | null
): Promise<TeamsCsr[]> {
  const result = await executor.execute(sql`
    SELECT u.id::text AS id, u.name, u.email, u.last_login_at,
           s.id::text AS supervisor_id
    FROM users u
    LEFT JOIN team_members tm
      ON tm.csr_user_id = u.id AND tm.program_id = u.program_id
    LEFT JOIN users s
      ON s.id = tm.supervisor_user_id
     AND s.role = 'supervisor'
     AND s.is_active = true
     AND s.program_id = u.program_id
    WHERE u.program_id = ${programId}::uuid
      AND u.role = 'csr'
      AND u.is_active = true
      ${onlySupervisorId === null ? sql`` : sql`AND s.id = ${onlySupervisorId}::uuid`}
    ORDER BY u.name, u.id
  `);
  return (
    result.rows as {
      id: string;
      name: string;
      email: string;
      last_login_at: unknown;
      supervisor_id: string | null;
    }[]
  ).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    lastLoginAt: isoOrNull(row.last_login_at),
    supervisorId: row.supervisor_id
  }));
}

/** Active supervisors in the program, or just `onlyId` when given. */
async function listSupervisors(
  programId: string,
  onlyId: string | null
): Promise<TeamsSupervisor[]> {
  const result = await db.execute(sql`
    SELECT id::text AS id, name, email
    FROM users
    WHERE program_id = ${programId}::uuid
      AND role = 'supervisor'
      AND is_active = true
      ${onlyId === null ? sql`` : sql`AND id = ${onlyId}::uuid`}
    ORDER BY name, id
  `);
  return (result.rows as { id: string; name: string; email: string }[]).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email
  }));
}

teamsRouter.get("/", teamsReadLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const programId = await programFor(req, res);
    if (programId === null) return;
    const actor = authedUser(req);
    // requireRole("supervisor") lets supervisors and everyone above through;
    // only the supervisor tier is narrowed to its own team.
    const ownTeam = actor.role === "supervisor" ? actor.id : null;
    const [supervisors, csrs] = await Promise.all([
      listSupervisors(programId, ownTeam),
      listCsrs(db as unknown as SqlExecutor, programId, ownTeam)
    ]);
    res.json({ supervisors, csrs, canEdit: ownTeam === null });
  } catch (err) {
    next(err);
  }
});

/**
 * `{ [csrId]: previous supervisor id or null }` for every requested CSR, in
 * request order. At the 200-id cap this is about 16 KB of JSON, which the
 * security_events `details` jsonb column takes without a size limit.
 */
export function previousSupervisorMap(
  csrIds: string[],
  rows: { csr_id: string; supervisor_id: string }[]
): Record<string, string | null> {
  const byCsr = new Map(rows.map((row) => [row.csr_id, row.supervisor_id]));
  return Object.fromEntries(csrIds.map((id) => [id, byCsr.get(id) ?? null]));
}

const CSRS_INVALID = "One or more people are not active CSRs in this program.";
const SUPERVISOR_INVALID = "Choose an active supervisor in this program.";

/**
 * Assign CSRs to a supervisor (`supervisorId`) or unassign them (`null`).
 * One transaction: lock the CSR and supervisor user rows, validate them,
 * write team_members, append the audit event, and read back the CSR list.
 * The locks make a concurrent role, program or active change wait, so the
 * validation still holds when the write lands.
 */
teamsRouter.put(
  "/assignments",
  requireManagerOrAbove,
  blockDemoWrites,
  teamsWriteLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const programId = await programFor(req, res);
      if (programId === null) return;
      const parsed = assignmentBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
        return;
      }
      const { csrIds, supervisorId } = parsed.data;
      const user = authedUser(req);

      type TxResult = { kind: "ok"; csrs: TeamsCsr[] } | { kind: "invalid"; error: string };
      const txResult = await db.transaction(async (tx): Promise<TxResult> => {
        const executor = tx as unknown as SqlExecutor;
        // One statement in id order locks every row this request depends on,
        // so two overlapping requests take their locks in the same order.
        const lockIds = supervisorId === null ? csrIds : [...csrIds, supervisorId];
        const locked = await executor.execute(sql`
          SELECT id::text AS id, role::text AS role, is_active,
                 program_id::text AS program_id
          FROM users
          WHERE id = ANY(${uuidArray(lockIds)})
          ORDER BY id
          FOR UPDATE
        `);
        const byId = new Map(
          (
            locked.rows as {
              id: string;
              role: string;
              is_active: boolean;
              program_id: string | null;
            }[]
          ).map((row) => [row.id, row])
        );
        const activeIn = (id: string, role: string): boolean => {
          const row = byId.get(id);
          return (
            row !== undefined &&
            row.role === role &&
            row.is_active === true &&
            row.program_id === programId
          );
        };
        if (!csrIds.every((id) => activeIn(id, "csr"))) {
          return { kind: "invalid", error: CSRS_INVALID };
        }
        if (supervisorId !== null && !activeIn(supervisorId, "supervisor")) {
          return { kind: "invalid", error: SUPERVISOR_INVALID };
        }

        // Each CSR's supervisor before this write, for the audit event. The
        // users rows above are locked, so the rows read here are current.
        const previous = await executor.execute(sql`
          SELECT csr_user_id::text AS csr_id, supervisor_user_id::text AS supervisor_id
          FROM team_members
          WHERE csr_user_id = ANY(${uuidArray(csrIds)})
        `);
        const previousSupervisorIds = previousSupervisorMap(
          csrIds,
          previous.rows as { csr_id: string; supervisor_id: string }[]
        );

        if (supervisorId === null) {
          await executor.execute(sql`
            DELETE FROM team_members WHERE csr_user_id = ANY(${uuidArray(csrIds)})
          `);
        } else {
          await executor.execute(sql`
            INSERT INTO team_members
              (csr_user_id, supervisor_user_id, program_id, assigned_by, assigned_at)
            SELECT t.id, ${supervisorId}::uuid, ${programId}::uuid, ${user.id}::uuid, now()
            FROM unnest(${uuidArray(csrIds)}) AS t(id)
            ON CONFLICT (csr_user_id) DO UPDATE SET
              supervisor_user_id = EXCLUDED.supervisor_user_id,
              program_id = EXCLUDED.program_id,
              assigned_by = EXCLUDED.assigned_by,
              assigned_at = now()
          `);
        }

        const requestId = res.getHeader("X-Request-Id");
        await appendSecurityEvent(
          {
            action: "team.assign",
            outcome: "success",
            actor: user,
            programId,
            resourceType: "team_members",
            resourceId: null,
            requestId: typeof requestId === "string" ? requestId : null,
            sourceIp: clientIpFrom(req),
            details: { count: csrIds.length, supervisorId, csrIds, previousSupervisorIds }
          },
          executor
        );

        return { kind: "ok", csrs: await listCsrs(executor, programId, null) };
      });

      if (txResult.kind === "invalid") {
        res.status(400).json({ error: txResult.error });
        return;
      }
      res.json({ csrs: txResult.csrs });
    } catch (err) {
      next(err);
    }
  }
);
