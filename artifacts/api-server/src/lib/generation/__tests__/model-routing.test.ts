import { describe, expect, it } from "vitest";
import {
  APPROVED_MODEL_ROUTES,
  DEFAULT_MODEL_ROUTE,
  findApprovedModelRoute,
  resolveApprovedModelRoute,
  resolveModelRouteOrder
} from "../model-routing.js";

describe("approved model routing", () => {
  it("defaults to GPT-5.6 Luna on OpenAI via OpenRouter at low reasoning", () => {
    expect(DEFAULT_MODEL_ROUTE).toMatchObject({
      id: "gpt-5.6-luna-openai",
      model: "openai/gpt-5.6-luna",
      provider: "openai",
      reasoningEffort: "low"
    });
  });

  it("contains only the reviewed routes, primary first", () => {
    expect(APPROVED_MODEL_ROUTES.map((route) => route.id)).toEqual([
      "gpt-5.6-luna-openai",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-super-digitalocean-nitro",
      "nemotron-3-ultra-together-nitro"
    ]);
  });

  it("rejects arbitrary model ids by resolving to the approved default", () => {
    expect(findApprovedModelRoute("unapproved")).toBeUndefined();
    expect(resolveApprovedModelRoute("unapproved")).toBe(DEFAULT_MODEL_ROUTE);
  });
});

describe("resolveModelRouteOrder", () => {
  it("honors the stored order, then appends any missing approved routes", () => {
    const chain = resolveModelRouteOrder([
      "nemotron-3-super-digitalocean-nitro",
      "gpt-5.6-luna-openai"
    ]);
    expect(chain.map((route) => route.id)).toEqual([
      "nemotron-3-super-digitalocean-nitro",
      "gpt-5.6-luna-openai",
      "gpt-5.4-nano-azure-nitro",
      "nemotron-3-ultra-together-nitro"
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
      "gpt-5.6-luna-openai",
      "nemotron-3-super-digitalocean-nitro",
      "nemotron-3-ultra-together-nitro"
    ]);
  });

  it("returns the full allowlist in listed order when given nothing", () => {
    expect(resolveModelRouteOrder([]).map((route) => route.id)).toEqual(
      APPROVED_MODEL_ROUTES.map((route) => route.id)
    );
  });
});

