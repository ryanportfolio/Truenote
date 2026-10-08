import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { CurrentUser } from "./auth/current-user.js";
import { db } from "./db-client.js";

/**
 * Supervisor teams. A supervisor sees only their own team (themselves plus
 * the CSRs assigned to them in team_members); manager and above see the
 * whole program. The table is raw SQL (lib/db/sql/0005_team_members.sql),
 * written by routes/admin/teams.ts.
 */

export const MAX_TEAM_ASSIGNMENT = 200;

/**
 * User ids a supervisor may see: their own id first, then their CSRs' ids.
 * `null` for every other role, meaning no team filter. Callers still apply
 * the program filter; this narrows within it.
 */
export async function teamScope(actor: CurrentUser): Promise<string[] | null> {
  if (actor.role !== "supervisor") return null;
  const result = await db.execute(sql`
    SELECT csr_user_id::text AS id
    FROM team_members
    WHERE supervisor_user_id = ${actor.id}::uuid
      AND program_id = ${actor.programId}::uuid
    ORDER BY csr_user_id
  `);
  const ids = (result.rows as { id: string }[]).map((row) => row.id);
  return [actor.id, ...ids];
}

/**
 * `AND <column> is in the team` for a WHERE clause, or an empty fragment
 * when `scope` is null. The column is compared as text so the same helper
 * works for users.id (uuid) and query_log.user_id (text). An empty scope
 * matches nothing.
 */
export function teamUserFilterSql(scope: string[] | null, column: SQL): SQL {
  if (scope === null) return sql``;
  const ids =
    scope.length === 0
      ? sql`ARRAY[]::text[]`
      : sql`ARRAY[${sql.join(
          scope.map((id) => sql`${id}`),
          sql`, `
        )}]::text[]`;
  return sql`AND ${column}::text = ANY(${ids})`;
}

const uuid = z.string().uuid();

/** PUT /api/admin/teams/assignments. `supervisorId: null` unassigns. */
export const assignmentBodySchema = z
  .object({
    csrIds: z
      .array(uuid, {
        required_error: "Pick at least one CSR.",
        invalid_type_error: "Send a list of ids."
      })
      .min(1, "Pick at least one CSR.")
      .max(MAX_TEAM_ASSIGNMENT, `Move at most ${MAX_TEAM_ASSIGNMENT} CSRs at a time.`)
      .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
    supervisorId: uuid
      .nullable()
      .transform((id) => (id === null ? null : id.toLowerCase()))
  })
  .strict();

export type AssignmentBody = z.infer<typeof assignmentBodySchema>;
