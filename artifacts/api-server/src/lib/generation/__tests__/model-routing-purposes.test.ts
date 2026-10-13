import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ rows: new Map<string, unknown>() }));

// app_settings in memory: SELECT by key and the upsert saveModelRouteOrder runs.
vi.mock("../../db-client.js", () => ({
  db: {
    execute: async (query: { queryChunks?: unknown[] }) => {
      const params = (query.queryChunks ?? []).filter(
        (chunk) => typeof chunk === "string" || typeof chunk === "number"
      ) as string[];
      const text = JSON.stringify(query);
      if (text.includes("INSERT INTO app_settings")) {
        const [key, value] = params;
        store.rows.set(String(key), JSON.parse(String(value)));
        return { rows: [] };
      }
      const key = params[0];
      return { rows: store.rows.has(String(key)) ? [{ value: store.rows.get(String(key)) }] : [] };
    }
  }
}));

const routing = await import("../model-routing.js");

function freshModule() {
  vi.resetModules();
  return import("../model-routing.js");
}

beforeEach(() => {
  store.rows.clear();
});

describe("compliance model chain", () => {
  it("follows the answers order until a compliance order is saved", async () => {
    const { APPROVED_MODEL_ROUTES } = routing;
    const reversed = [...APPROVED_MODEL_ROUTES].reverse().map((route) => route.id);
    store.rows.set("primary_generation_route", { order: reversed });
    const mod = await freshModule();
    expect((await mod.getActiveModelChain("compliance")).map((route) => route.id)).toEqual(reversed);

    const own = [APPROVED_MODEL_ROUTES[2]!.id];
    await mod.saveModelRouteOrder(own, "00000000-0000-4000-8000-000000000001", "compliance");
    expect(store.rows.has("compliance_generation_route")).toBe(true);
    expect((await mod.getActiveModelChain("compliance"))[0]!.id).toBe(APPROVED_MODEL_ROUTES[2]!.id);
    // The answers chain is untouched.
    expect((await mod.getActiveModelChain("answers")).map((route) => route.id)).toEqual(reversed);
  });

  it("picks up a new answers order at once while it still follows answers", async () => {
    const { APPROVED_MODEL_ROUTES } = routing;
    const mod = await freshModule();
    const before = (await mod.getActiveModelChain("compliance"))[0]!.id;
    const nextPrimary = APPROVED_MODEL_ROUTES.find((route) => route.id !== before)!.id;
    await mod.saveModelRouteOrder([nextPrimary], "00000000-0000-4000-8000-000000000001", "answers");
    expect((await mod.getActiveModelChain("compliance"))[0]!.id).toBe(nextPrimary);
  });
});
