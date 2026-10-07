import { describe, expect, it } from "vitest";
import {
  APPROVED_MODEL_ROUTES,
  DEFAULT_MODEL_ROUTE,
  findApprovedModelRoute,
  resolveApprovedModelRoute,
  resolveModelRouteOrder
} from "../model-routing.js";

describe("approved model routing", () => {
  it("defaults to Nemotron 3 Super on a ZDR-capable route", () => {
    expect(DEFAULT_MODEL_ROUTE).toMatchObject({
      id: "nemotron-3-super-deepinfra-nitro",
      model: "nvidia/nemotron-3-super-120b-a12b:nitro",
      provider: "deepinfra",
      reasoningEffort: "medium"
    });
  });

  it("contains only the reviewed routes, primary first", () => {
    expect(APPROVED_MODEL_ROUTES.map((route) => route.id)).toEqual([
      "nemotron-3-super-deepinfra-nitro",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-ultra-baseten-nitro",
      "mercury-2-inception",
      "granite-4.2-8b-coreweave"
    ]);
  });

  it("includes Mercury 2 through Inception at low reasoning", () => {
    expect(findApprovedModelRoute("mercury-2-inception")).toMatchObject({
      model: "inception/mercury-2",
      provider: "inception",
      reasoningEffort: "low"
    });
  });

  it("pins every route to a provider with a listed ZDR endpoint", () => {
    expect(
      APPROVED_MODEL_ROUTES.map((route) => [route.model, route.provider])
    ).toEqual([
      ["nvidia/nemotron-3-super-120b-a12b:nitro", "deepinfra"],
      ["openai/gpt-5.4-nano:nitro", "azure"],
      ["nvidia/nemotron-3-ultra-550b-a55b:nitro", "baseten"],
      ["inception/mercury-2", "inception"],
      ["ibm-granite/granite-4.2-8b", "coreweave"]
    ]);
  });

  it("pins Granite 4.2 8B to CoreWeave at low reasoning", () => {
    expect(findApprovedModelRoute("granite-4.2-8b-coreweave")).toMatchObject({
      model: "ibm-granite/granite-4.2-8b",
      provider: "coreweave",
      reasoningEffort: "low"
    });
  });

  it("rejects arbitrary model ids by resolving to the approved default", () => {
    expect(findApprovedModelRoute("unapproved")).toBeUndefined();
    expect(resolveApprovedModelRoute("unapproved")).toBe(DEFAULT_MODEL_ROUTE);
  });
});

describe("resolveModelRouteOrder", () => {
  it("honors stored approved routes and drops the removed non-ZDR Luna route", () => {
    const chain = resolveModelRouteOrder([
      "mercury-2-inception",
      "gpt-5.6-luna-openai"
    ]);
    expect(chain.map((route) => route.id)).toEqual([
      "mercury-2-inception",
      "nemotron-3-super-deepinfra-nitro",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-ultra-baseten-nitro",
      "granite-4.2-8b-coreweave"
    ]);
  });

  it("drops unknown ids and collapses duplicates", () => {
    const chain = resolveModelRouteOrder([
      "unapproved",
      "gpt-5.4-nano-azure-nitro",
      "gpt-5.4-nano-azure-nitro"
    ]);
    expect(chain.map((route) => route.id)).toEqual([
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-super-deepinfra-nitro",
      "nemotron-3-ultra-baseten-nitro",
      "mercury-2-inception",
      "granite-4.2-8b-coreweave"
    ]);
  });

  it("keeps the positions of retired route ids by mapping them to their replacements", () => {
    const chain = resolveModelRouteOrder([
      "granite-4.1-8b-wandb",
      "mercury-2-inception",
      "nemotron-3-ultra-together-nitro",
      "nemotron-3-super-digitalocean-nitro",
      "nemotron-3-super-deepinfra-nitro"
    ]);
    expect(chain.map((route) => route.id)).toEqual([
      "granite-4.2-8b-coreweave",
      "mercury-2-inception",
      "nemotron-3-ultra-baseten-nitro",
      "nemotron-3-super-deepinfra-nitro",
      "gpt-5.4-nano-azure-nitro"
    ]);
  });

  it("returns the full allowlist in listed order when given nothing", () => {
    expect(resolveModelRouteOrder([]).map((route) => route.id)).toEqual(
      APPROVED_MODEL_ROUTES.map((route) => route.id)
    );
  });
});

