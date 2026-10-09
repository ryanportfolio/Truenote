import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state = vi.hoisted(() => ({
  sessions: [] as any[], logs: [] as any[], snapshots: [] as any[], versions: [] as any[], chunks: [] as any[],
  clearance: "internal", fail: "", queries: [] as { sql: string; params: unknown[] }[]
}));
vi.mock("../../lib/db-client.js", () => ({ db: {
  select: (fields: any) => {
    let rows: any[] = [];
    const chain: any = {
      from: () => { rows = "citedChunkIds" in fields ? state.logs : "chunkId" in fields ? state.chunks : state.sessions; return chain; },
      where: () => chain, innerJoin: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject)
    };
    return chain;
  },
  execute: async (query: any) => {
    const compiled = new PgDialect().sqlToQuery(query);
    state.queries.push(compiled);
    const text = compiled.sql;
    if (text.includes("FROM users")) {
      if (state.fail === "clearance") throw new Error("clearance unavailable");
      return { rows: [{ max_classification: state.clearance }] };
    }
    if (text.includes("FROM query_log")) {
      if (state.fail === "snapshots") throw new Error("snapshots unavailable");
      return { rows: state.snapshots };
    }
    if (text.includes("FROM chunks")) {
      if (state.fail === "chunks") throw new Error("chunks unavailable");
      return { rows: state.chunks };
    }
    if (text.includes("FROM document_versions")) {
      if (state.fail === "versions") throw new Error("versions unavailable");
      return { rows: state.versions };
    }
    throw new Error(`Unexpected query: ${text}`);
  }
} }));
vi.mock("../../lib/auth/effective-program.js", () => ({ resolveEffectiveProgramId: async () => PROGRAM }));
vi.mock("../../lib/observability/error-log.js", () => ({ recordAppError: vi.fn() }));
import { sessionsRouter } from "../sessions.js";

const PROGRAM = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const LOG = "00000000-0000-4000-8000-000000000004";
const CHUNK = "00000000-0000-4000-8000-000000000005";
const DOC = "00000000-0000-4000-8000-000000000006";
const VERSION = "00000000-0000-4000-8000-000000000007";
const OTHER = "00000000-0000-4000-8000-000000000008";

async function request(path: "/" | "/:id") {
  const route = (sessionsRouter as any).stack.find((layer: any) => layer.route?.path === path).route;
  let body: any;
  let error: unknown;
  const res: any = { status: () => res, json: (value: any) => { body = value; return res; } };
  await route.stack.at(-1).handle({ params: { id: SESSION }, user: { id: USER }, query: {} }, res, (err: unknown) => { error = err; });
  return { body, error };
}
function expectHidden(result: Awaited<ReturnType<typeof request>>) {
  const encoded = JSON.stringify(result.body ?? {});
  for (const text of ["PRIVATE QUESTION", "PRIVATE ANSWER", "PRIVATE TITLE", "PRIVATE EXCERPT"]) expect(encoded).not.toContain(text);
}
beforeEach(() => {
  state.sessions = [{ id: SESSION, title: "PRIVATE TITLE", updatedAt: new Date() }];
  state.logs = [{ id: LOG, sessionId: SESSION, question: "PRIVATE QUESTION", answer: "PRIVATE ANSWER", citedChunkIds: [CHUNK], refused: false, latencyMs: 5, feedback: null }];
  state.snapshots = [{ id: LOG, citation_snapshots: [{ chunk_id: CHUNK, doc_title: "Document", excerpt: "PRIVATE EXCERPT", doc_id: DOC, document_version_id: VERSION, version_number: 1, citation_index: 0, source_start: null, source_end: null }] }];
  state.versions = [{ id: VERSION, document_id: DOC, program_id: PROGRAM, document_lifecycle_state: "active", is_active: true, lifecycle_state: "active", classification: "internal", source_program_id: PROGRAM, source_active: true, source_approved_at: "2026-01-01", source_retired_at: null, revoked_at: null }];
  state.chunks = [{ chunkId: CHUNK, content: "PRIVATE EXCERPT", metadata: {}, docId: DOC, docTitle: "Document", documentVersionId: VERSION, versionNumber: 1, programId: PROGRAM }];
  state.clearance = "internal"; state.fail = ""; state.queries = [];
});

describe("history current authorization", () => {
  it("preserves currently authorized snapshots and titles", async () => {
    const result = await request("/:id");
    expect(result.error).toBeUndefined();
    expect(result.body.exchanges[0].answer).toBe("PRIVATE ANSWER");
    expect(result.body.exchanges[0].sources[0].excerpt).toBe("PRIVATE EXCERPT");
    expect((await request("/")).body.items[0].title).toBe("PRIVATE TITLE");
  });
  it.each([
    ["clearance lowered", { classification: "restricted" }],
    ["version revoked", { lifecycle_state: "revoked", is_active: false }],
    ["pending version", { lifecycle_state: "pending_review" }],
    ["inactive active version", { is_active: false }],
    ["document retired", { document_lifecycle_state: "retired" }],
    ["document moved", { program_id: OTHER }],
    ["source moved", { source_program_id: OTHER }],
    ["source withdrawn", { source_active: false }],
    ["source unapproved", { source_approved_at: null }],
    ["source retired", { source_retired_at: "2026-01-01" }],
    ["revocation timestamp", { revoked_at: "2026-01-01" }],
    ["unknown classification", { classification: "invalid" }]
  ])("hides exchange and list title when %s", async (_name, patch) => {
    Object.assign(state.versions[0], patch);
    expectHidden(await request("/:id"));
    expectHidden(await request("/"));
  });
  it("hides a deleted document's entire exchange", async () => {
    state.versions = [];
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("keeps explicit superseded receipts while document and source remain authorized", async () => {
    Object.assign(state.versions[0], { is_active: false, lifecycle_state: "retired" });
    const result = await request("/:id");
    expect(result.body.exchanges[0].sources[0].superseded).toBe(true);
  });
  it("hides an entire exchange after partial source loss", async () => {
    state.logs[0].citedChunkIds.push(OTHER);
    state.snapshots[0].citation_snapshots.push({ ...state.snapshots[0].citation_snapshots[0], chunk_id: OTHER, document_version_id: OTHER, citation_index: 1 });
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it.each([false, true])("hides ungrounded history, refused=%s", async (refused) => {
    state.logs[0].citedChunkIds = []; state.logs[0].refused = refused; state.snapshots = [];
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it.each(["versions", "clearance", "snapshots"])("fails closed on %s lookup failure", async (failure) => {
    state.fail = failure;
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it.each([[], null, [{ bad: true }]])("checks legacy chunks for absent or malformed snapshots: %j", async (snapshots) => {
    state.snapshots[0].citation_snapshots = snapshots;
    Object.assign(state.versions[0], { classification: "restricted" });
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("preserves authorized legacy chunks without claiming durable receipt", async () => {
    state.snapshots = [];
    const result = await request("/:id");
    expect(result.body.exchanges[0].sources[0].document_version_id).toBeNull();
    expect(result.body.exchanges[0].answer).toBe("PRIVATE ANSWER");
  });
  it("rejects legacy superseded chunks without a durable receipt", async () => {
    state.snapshots = []; Object.assign(state.versions[0], { is_active: false, lifecycle_state: "retired" });
    expectHidden(await request("/:id"));
  });
  it("rejects a receipt whose document does not match its version", async () => {
    state.snapshots[0].citation_snapshots[0].doc_id = OTHER;
    expectHidden(await request("/:id"));
  });
});

describe("history receipt edge cases", () => {
  it("keeps safe exchanges but clears a mixed session title in both responses", async () => {
    state.logs.push({ ...state.logs[0], id: OTHER, question: "SAFE QUESTION", answer: "SAFE ANSWER", citedChunkIds: [OTHER] });
    state.snapshots.push({ id: OTHER, citation_snapshots: [{ ...state.snapshots[0].citation_snapshots[0], chunk_id: OTHER, document_version_id: OTHER, excerpt: "SAFE EXCERPT" }] });
    state.versions.push({ ...state.versions[0], id: OTHER });
    state.versions[0].classification = "restricted";
    const detail = await request("/:id");
    expect(detail.error).toBeUndefined();
    expect(detail.body.title).toBeNull();
    expect(detail.body.exchanges).toHaveLength(1);
    expect(detail.body.exchanges[0].answer).toBe("SAFE ANSWER");
    expectHidden(detail);
    const list = await request("/");
    expect(list.error).toBeUndefined();
    expect(list.body.items[0].title).toBeNull();
    expectHidden(list);
  });
  it("does not release a title without any exchanges to authorize", async () => {
    state.logs = [];
    expect((await request("/:id")).body.title).toBeNull();
    expect((await request("/")).body.items).toEqual([]);
  });
  it("withholds a title named from an opening refusal but lists the session", async () => {
    state.logs.unshift({ ...state.logs[0], id: OTHER, question: "REFUSED QUESTION", answer: "REFUSAL", citedChunkIds: [], refused: true });
    state.sessions[0].title = "REFUSED QUESTION";
    const detail = await request("/:id");
    expect(detail.body.title).toBeNull();
    expect(detail.body.exchanges).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain("REFUSED QUESTION");
    const list = await request("/");
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].title).toBeNull();
  });
  it("keeps the title when a later exchange is a content-free refusal", async () => {
    state.logs.push({ ...state.logs[0], id: OTHER, question: "REFUSED QUESTION", answer: "REFUSAL", citedChunkIds: [], refused: true });
    const detail = await request("/:id");
    expect(detail.body.title).toBe("PRIVATE TITLE");
    expect(detail.body.exchanges).toHaveLength(1);
    expect(JSON.stringify(detail.body)).not.toContain("REFUSED QUESTION");
    expect((await request("/")).body.items[0].title).toBe("PRIVATE TITLE");
  });
  it("still withholds the title for an uncited exchange that is not a refusal", async () => {
    state.logs.push({ ...state.logs[0], id: OTHER, question: "UNCITED QUESTION", answer: "UNCITED ANSWER", citedChunkIds: [], refused: false });
    expect((await request("/:id")).body.title).toBeNull();
    expect((await request("/")).body.items[0].title).toBeNull();
  });
  it("leaves sessions with no visible exchange out of the list", async () => {
    state.logs[0].citedChunkIds = []; state.logs[0].refused = true; state.snapshots = [];
    expect((await request("/")).body.items).toEqual([]);
    state.logs[0].citedChunkIds = [CHUNK]; state.logs[0].refused = false; state.versions = [];
    expect((await request("/")).body.items).toEqual([]);
  });
  it("rejects a durable receipt with no version identity", async () => {
    state.snapshots[0].citation_snapshots[0].document_version_id = null;
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("requires every legacy chunk to exist", async () => {
    state.snapshots = []; state.chunks = [];
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("withholds partial legacy evidence", async () => {
    state.snapshots = []; state.logs[0].citedChunkIds.push(OTHER);
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("rejects a cross-program legacy chunk", async () => {
    state.snapshots = []; state.chunks[0].programId = OTHER;
    expectHidden(await request("/:id"));
  });
  it("fails closed when legacy chunk lookup fails", async () => {
    state.snapshots = []; state.fail = "chunks";
    expectHidden(await request("/:id")); expectHidden(await request("/"));
  });
  it("uses current legacy evidence instead of a mismatched saved receipt", async () => {
    state.snapshots[0].citation_snapshots[0].chunk_id = OTHER;
    state.snapshots[0].citation_snapshots[0].excerpt = "MISMATCHED RECEIPT";
    const result = await request("/:id");
    expect(result.error).toBeUndefined();
    expect(result.body.exchanges[0].sources[0].excerpt).toBe("PRIVATE EXCERPT");
    expect(JSON.stringify(result.body)).not.toContain("MISMATCHED RECEIPT");
  });
});
