import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { assignmentBodySchema, MAX_TEAM_ASSIGNMENT, teamUserFilterSql } from "../teams.js";

const A = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";
const B = "4f1f7a8e-2d1b-4c55-9a0e-6f2d9b8c1a11";
const SUPERVISOR = "0e7c4f8a-3b2d-4c1e-9f6a-5d8b7c6e4a21";

const dialect = new PgDialect();

function uuidAt(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

describe("assignmentBodySchema", () => {
  it("accepts csr ids with a supervisor, or null to unassign", () => {
    const parsed = assignmentBodySchema.safeParse({ csrIds: [A, B], supervisorId: SUPERVISOR });
    expect(parsed.success && parsed.data).toEqual({ csrIds: [A, B], supervisorId: SUPERVISOR });
    const unassign = assignmentBodySchema.safeParse({ csrIds: [A], supervisorId: null });
    expect(unassign.success && unassign.data).toEqual({ csrIds: [A], supervisorId: null });
  });

  it("rejects an empty list and more than 200 ids", () => {
    expect(assignmentBodySchema.safeParse({ csrIds: [], supervisorId: null }).success).toBe(false);
    const max = Array.from({ length: MAX_TEAM_ASSIGNMENT }, (_, i) => uuidAt(i));
    expect(MAX_TEAM_ASSIGNMENT).toBe(200);
    expect(assignmentBodySchema.safeParse({ csrIds: max, supervisorId: null }).success).toBe(true);
    expect(
      assignmentBodySchema.safeParse({ csrIds: [...max, uuidAt(200)], supervisorId: null }).success
    ).toBe(false);
  });

  it("rejects non-uuid ids, a missing supervisorId and extra fields", () => {
    expect(assignmentBodySchema.safeParse({ csrIds: ["not-a-uuid"], supervisorId: null }).success).toBe(false);
    expect(assignmentBodySchema.safeParse({ csrIds: [A], supervisorId: "nope" }).success).toBe(false);
    expect(assignmentBodySchema.safeParse({ csrIds: [A] }).success).toBe(false);
    expect(assignmentBodySchema.safeParse({ csrIds: A, supervisorId: null }).success).toBe(false);
    expect(
      assignmentBodySchema.safeParse({ csrIds: [A], supervisorId: null, programId: B }).success
    ).toBe(false);
  });

  it("dedupes ids case-insensitively and lowercases them", () => {
    const parsed = assignmentBodySchema.safeParse({
      csrIds: [A, A.toUpperCase(), B],
      supervisorId: SUPERVISOR.toUpperCase()
    });
    expect(parsed.success && parsed.data).toEqual({ csrIds: [A, B], supervisorId: SUPERVISOR });
  });
});

describe("teamUserFilterSql", () => {
  it("adds no filter for a null scope", () => {
    const query = dialect.sqlToQuery(teamUserFilterSql(null, sql.raw("q.user_id")));
    expect(query.sql).toBe("");
    expect(query.params).toEqual([]);
  });

  it("compares the column as text against the scope ids", () => {
    const query = dialect.sqlToQuery(teamUserFilterSql([SUPERVISOR, A], sql.raw("u.id")));
    expect(query.sql).toBe("AND u.id::text = ANY(ARRAY[$1, $2]::text[])");
    expect(query.params).toEqual([SUPERVISOR, A]);
  });

  it("matches nothing for an empty scope", () => {
    const query = dialect.sqlToQuery(teamUserFilterSql([], sql.raw("q.user_id")));
    expect(query.sql).toBe("AND q.user_id::text = ANY(ARRAY[]::text[])");
    expect(query.params).toEqual([]);
  });
});
