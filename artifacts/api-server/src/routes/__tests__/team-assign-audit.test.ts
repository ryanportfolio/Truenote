import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response, Router } from "express";
import type { CurrentUser } from "../../lib/auth/current-user.js";
import { previousSupervisorMap, teamsRouter } from "../admin/teams.js";

/**
 * Runs the real PUT /api/admin/teams/assignments handler against a fake
 * db-client that records every statement, then reads the `details` jsonb
 * passed to append_security_event.
 */
const fake = vi.hoisted(() => ({
  respond: null as null | ((query: unknown) => unknown[])
}));

vi.mock("../../lib/db-client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/db-client.js")>();
  const execute = async (query: unknown) => ({ rows: fake.respond?.(query) ?? [] });
  const db = {
    execute,
    transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) =>
      fn({ execute })
  };
  return { ...original, db };
});

const PROGRAM = "00000000-0000-4000-8000-0000000000aa";
const MANAGER: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "mgr@example.com",
  role: "manager",
  programId: PROGRAM,
  name: "Mgr",
  mustResetPassword: false
};
const NEW_SUP = "00000000-0000-4000-8000-000000000010";
const OLD_SUP = "00000000-0000-4000-8000-000000000011";
const CSR_ON_TEAM = "00000000-0000-4000-8000-000000000021";
const CSR_UNASSIGNED = "00000000-0000-4000-8000-000000000022";

const dialect = new PgDialect();
let statements: string[] = [];
let auditDetails: unknown = undefined;

function respond(query: unknown): unknown[] {
  const rendered = dialect.sqlToQuery(query as SQL);
  const text = rendered.sql.replace(/\s+/g, " ").trim();
  statements.push(text);
  if (text.includes("FOR UPDATE") && text.includes("FROM users")) {
    return [
      { id: CSR_ON_TEAM, role: "csr", is_active: true, program_id: PROGRAM },
      { id: CSR_UNASSIGNED, role: "csr", is_active: true, program_id: PROGRAM },
      { id: NEW_SUP, role: "supervisor", is_active: true, program_id: PROGRAM }
    ];
  }
  if (text.startsWith("SELECT csr_user_id::text AS csr_id")) {
    return [{ csr_id: CSR_ON_TEAM, supervisor_id: OLD_SUP }];
  }
  if (text.includes("append_security_event")) {
    const json = rendered.params.find(
      (param) => typeof param === "string" && param.startsWith("{")
    );
    auditDetails = JSON.parse(String(json));
    return [{ id: "evt", occurred_at: new Date(), event_hash: "hash" }];
  }
  return [];
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function putAssignmentsHandler(): Handler {
  const stack = (teamsRouter as unknown as Router & {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
    }>;
  }).stack;
  const layer = stack.find(
    (candidate) => candidate.route?.path === "/assignments" && candidate.route.methods.put
  );
  const handlers = layer?.route?.stack ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  return handlers[handlers.length - 1]!.handle;
}

async function assign(
  body: unknown
): Promise<{ status: number; error: unknown }> {
  let status = 200;
  let error: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
    getHeader: () => undefined
  } as unknown as Response;
  const req = {
    method: "PUT",
    body,
    user: MANAGER,
    ip: "127.0.0.1",
    params: {},
    header: () => undefined
  } as unknown as Request;
  await putAssignmentsHandler()(req, res, (err?: unknown) => {
    error = err ?? null;
  });
  return { status, error };
}

beforeEach(() => {
  statements = [];
  auditDetails = undefined;
  fake.respond = respond;
});

describe("team.assign audit details", () => {
  it("records the CSRs and each one's previous supervisor, keeping count and supervisorId", async () => {
    const result = await assign({
      csrIds: [CSR_ON_TEAM, CSR_UNASSIGNED.toUpperCase()],
      supervisorId: NEW_SUP
    });
    expect(result).toEqual({ status: 200, error: null });
    expect(auditDetails).toEqual({
      count: 2,
      supervisorId: NEW_SUP,
      csrIds: [CSR_ON_TEAM, CSR_UNASSIGNED],
      previousSupervisorIds: { [CSR_ON_TEAM]: OLD_SUP, [CSR_UNASSIGNED]: null }
    });
  });

  it("reads the previous assignments after the users lock and before the write", async () => {
    await assign({ csrIds: [CSR_ON_TEAM, CSR_UNASSIGNED], supervisorId: null });
    const lockIndex = statements.findIndex(
      (text) => text.includes("FROM users") && text.includes("FOR UPDATE")
    );
    const readIndex = statements.findIndex((text) =>
      text.startsWith("SELECT csr_user_id::text AS csr_id")
    );
    const writeIndex = statements.findIndex((text) =>
      text.startsWith("DELETE FROM team_members")
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(lockIndex);
    expect(writeIndex).toBeGreaterThan(readIndex);
    expect(auditDetails).toMatchObject({
      supervisorId: null,
      previousSupervisorIds: { [CSR_ON_TEAM]: OLD_SUP, [CSR_UNASSIGNED]: null }
    });
  });
});

describe("previousSupervisorMap", () => {
  it("maps every requested CSR, null when it had no team row", () => {
    expect(
      previousSupervisorMap(
        [CSR_ON_TEAM, CSR_UNASSIGNED],
        [{ csr_id: CSR_ON_TEAM, supervisor_id: OLD_SUP }]
      )
    ).toEqual({ [CSR_ON_TEAM]: OLD_SUP, [CSR_UNASSIGNED]: null });
  });

  it("stays small at the 200-id cap", () => {
    const ids = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
    );
    const map = previousSupervisorMap(
      ids,
      ids.map((id) => ({ csr_id: id, supervisor_id: OLD_SUP }))
    );
    expect(Object.keys(map)).toHaveLength(200);
    const details = JSON.stringify({ count: 200, supervisorId: NEW_SUP, csrIds: ids, previousSupervisorIds: map });
    expect(details.length).toBeLessThan(32 * 1024);
  });
});
