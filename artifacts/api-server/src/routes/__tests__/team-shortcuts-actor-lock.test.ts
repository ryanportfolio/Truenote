import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response, Router } from "express";
import type { CurrentUser } from "../../lib/auth/current-user.js";
import { kbLibraryRouter } from "../kb-library.js";

/**
 * Runs the real PUT /api/kb/library/team-shortcuts handler against a fake
 * db-client that records every statement in order, so the test sees whether
 * the actor's users row is locked and revalidated before any shortcut row
 * is deleted.
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
const OTHER_PROGRAM = "00000000-0000-4000-8000-0000000000bb";
const DOC = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";
const SUPERVISOR: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "sup@example.com",
  role: "supervisor",
  programId: PROGRAM,
  name: "Sup",
  mustResetPassword: false
};
const TEAM_PINNER_MESSAGE = "Only supervisors can recommend sources to a team.";

const dialect = new PgDialect();
let statements: string[] = [];
let actorRow: Record<string, unknown> | undefined;

function respond(query: unknown): unknown[] {
  const text = dialect.sqlToQuery(query as SQL).sql.replace(/\s+/g, " ").trim();
  statements.push(text);
  if (text.includes("max_classification")) return [{ max_classification: "restricted" }];
  if (/FROM users WHERE id = \$1::uuid FOR SHARE/.test(text)) {
    return actorRow ? [actorRow] : [];
  }
  if (text.includes("unnest") && text.startsWith("SELECT count(*)")) return [{ count: 1 }];
  if (text.startsWith("SELECT count(*)::int AS count FROM kb_team_shortcuts")) {
    return [{ count: 1 }];
  }
  if (text.includes("append_security_event")) {
    return [{ id: "evt", occurred_at: new Date(), event_hash: "hash" }];
  }
  return [];
}

type Handler = (req: Request, res: Response, next: NextFunction) => unknown;

function putTeamShortcutsHandler(): Handler {
  const stack = (kbLibraryRouter as unknown as Router & {
    stack: Array<{
      route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
    }>;
  }).stack;
  const layer = stack.find(
    (candidate) => candidate.route?.path === "/team-shortcuts" && candidate.route.methods.put
  );
  const handlers = layer?.route?.stack ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  return handlers[handlers.length - 1]!.handle;
}

async function save(): Promise<{ status: number; body: unknown; error: unknown }> {
  let status = 200;
  let body: unknown = null;
  let error: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return res;
    },
    json(payload: unknown) {
      body = payload;
      return res;
    },
    getHeader: () => undefined
  } as unknown as Response;
  const req = {
    method: "PUT",
    body: { documentIds: [DOC] },
    user: SUPERVISOR,
    ip: "127.0.0.1",
    params: {},
    header: () => undefined
  } as unknown as Request;
  await putTeamShortcutsHandler()(req, res, (err?: unknown) => {
    error = err ?? null;
  });
  return { status, body, error };
}

const isActorLock = (text: string) => /FROM users WHERE id = \$1::uuid FOR SHARE/.test(text);
const isShortcutDelete = (text: string) => text.startsWith("DELETE FROM kb_team_shortcuts");
const isShortcutWrite = (text: string) =>
  /^(DELETE FROM|INSERT INTO|UPDATE) kb_team_shortcuts/.test(text);

beforeEach(() => {
  statements = [];
  actorRow = { role: "supervisor", program_id: PROGRAM, is_active: true };
  fake.respond = respond;
});

describe("PUT /team-shortcuts actor lock", () => {
  it("locks the actor's users row FOR SHARE after the library lock and before any DELETE", async () => {
    const result = await save();
    expect(result).toEqual({ status: 200, body: { ok: true }, error: null });

    const lockIndex = statements.findIndex(isActorLock);
    const deleteIndex = statements.findIndex(isShortcutDelete);
    const advisoryIndex = statements.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(lockIndex);
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(advisoryIndex).toBeLessThan(lockIndex);
    expect(statements[lockIndex]).toMatch(/^SELECT role, program_id, is_active FROM users/);
  });

  it.each([
    ["demoted to CSR", { role: "csr", program_id: PROGRAM, is_active: true }],
    ["promoted to manager", { role: "manager", program_id: PROGRAM, is_active: true }],
    ["moved to another program", { role: "supervisor", program_id: OTHER_PROGRAM, is_active: true }],
    ["deactivated", { role: "supervisor", program_id: PROGRAM, is_active: false }],
    ["deleted", undefined]
  ])("refuses with 403 and writes nothing when the actor was %s", async (_label, row) => {
    actorRow = row;
    const result = await save();
    expect(result).toEqual({
      status: 403,
      body: { error: TEAM_PINNER_MESSAGE },
      error: null
    });
    expect(statements.some(isActorLock)).toBe(true);
    expect(statements.some(isShortcutWrite)).toBe(false);
    expect(statements.some((text) => text.includes("append_security_event"))).toBe(false);
  });
});
