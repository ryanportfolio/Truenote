import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  openingId: "", title: null as string | null, updates: [] as unknown[]
}));
vi.mock("../../lib/db-client.js", () => ({ db: {
  select: (fields: Record<string, unknown>) => {
    const rows = () => "id" in fields ? [{ id: state.openingId }] : [{ title: state.title }];
    const chain: any = {
      from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
      then: (resolve: any, reject: any) => Promise.resolve(rows()).then(resolve, reject)
    };
    return chain;
  },
  update: () => ({ set: (value: unknown) => ({ where: async () => { state.updates.push(value); } }) })
} }));
vi.mock("../../lib/generation/name-session.js", () => ({
  nameSession: async ({ question }: { question: string }) => `Title from ${question}`
}));
vi.mock("../../lib/observability/error-log.js", () => ({ recordAppError: vi.fn() }));
import { nameSessionFromOpening } from "../ask.js";

const SESSION = "00000000-0000-4000-8000-000000000003";
const OPENING = "00000000-0000-4000-8000-000000000004";
const LATER = "00000000-0000-4000-8000-000000000005";
const diagnostics = { correlationId: "c", userId: "u", programId: "p" };

beforeEach(() => {
  state.openingId = OPENING; state.title = null; state.updates = [];
});

describe("session naming", () => {
  it("names the session from its opening exchange", async () => {
    await nameSessionFromOpening(SESSION, OPENING, "OPENING QUESTION", "answer", diagnostics);
    expect(state.updates).toEqual([{ title: "Title from OPENING QUESTION" }]);
  });
  it("never names the session from a later exchange, even while the title is unset", async () => {
    await nameSessionFromOpening(SESSION, LATER, "LATER REFUSED QUESTION", "refusal", diagnostics);
    expect(state.updates).toEqual([]);
  });
  it("leaves an existing title alone", async () => {
    state.title = "Existing";
    await nameSessionFromOpening(SESSION, OPENING, "OPENING QUESTION", "answer", diagnostics);
    expect(state.updates).toEqual([]);
  });
});
