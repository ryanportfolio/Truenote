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
      id: "nemotron-3-super-digitalocean-nitro",
      model: "nvidia/nemotron-3-super-120b-a12b:nitro",
      provider: "digitalocean",
      reasoningEffort: "medium"
    });
  });

  it("contains only the reviewed routes, primary first", () => {
    expect(APPROVED_MODEL_ROUTES.map((route) => route.id)).toEqual([
      "nemotron-3-super-digitalocean-nitro",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-ultra-together-nitro",
      "mercury-2-inception",
      "granite-4.1-8b-wandb"
    ]);
  });

  it("includes Mercury 2 through Inception at low reasoning", () => {
    expect(findApprovedModelRoute("mercury-2-inception")).toMatchObject({
      model: "inception/mercury-2",
      provider: "inception",
      reasoningEffort: "low"
    });
  });

  it("pins Granite 4.1 8B to WandB without unsupported reasoning controls", () => {
    expect(findApprovedModelRoute("granite-4.1-8b-wandb")).toMatchObject({
      model: "ibm-granite/granite-4.1-8b",
      provider: "wandb",
      reasoningEffort: "none"
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
      "nemotron-3-super-digitalocean-nitro",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-ultra-together-nitro",
      "granite-4.1-8b-wandb"
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
      "nemotron-3-super-digitalocean-nitro",
      "nemotron-3-ultra-together-nitro",
      "mercury-2-inception",
      "granite-4.1-8b-wandb"
    ]);
  });

  it("returns the full allowlist in listed order when given nothing", () => {
    expect(resolveModelRouteOrder([]).map((route) => route.id)).toEqual(
      APPROVED_MODEL_ROUTES.map((route) => route.id)
    );
  });
});

