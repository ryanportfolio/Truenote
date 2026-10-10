import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWebAuthnConfig } from "../webauthn-config.js";

beforeEach(() => {
  vi.stubEnv("WEBAUTHN_RP_ID", undefined);
  vi.stubEnv("WEBAUTHN_ORIGINS", undefined);
  vi.stubEnv("APP_BASE_URL", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("WebAuthn relying party config", () => {
  it("derives the RP ID and origin from APP_BASE_URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASE_URL", "https://truenote.org/");
    expect(getWebAuthnConfig()).toEqual({
      rpId: "truenote.org",
      rpName: "Truenote",
      origins: ["https://truenote.org"]
    });
  });

  it("prefers WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_BASE_URL", "https://web-production.example.app");
    vi.stubEnv("WEBAUTHN_RP_ID", "truenote.org");
    vi.stubEnv("WEBAUTHN_ORIGINS", "https://truenote.org, https://www.truenote.org");
    expect(getWebAuthnConfig()).toMatchObject({
      rpId: "truenote.org",
      origins: ["https://truenote.org", "https://www.truenote.org"]
    });
  });

  it("uses the local preview outside production when nothing is set", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(getWebAuthnConfig()).toMatchObject({ rpId: "localhost", origins: ["http://localhost:5180"] });
  });

  it.each([
    ["nothing set", {}],
    ["a plain-http origin", { APP_BASE_URL: "http://truenote.org" }],
    ["an origin outside the RP ID", { WEBAUTHN_RP_ID: "truenote.org", WEBAUTHN_ORIGINS: "https://evil.example" }],
    ["an origin that does not parse", { WEBAUTHN_RP_ID: "truenote.org", WEBAUTHN_ORIGINS: "truenote.org" }],
    ["an RP ID with a scheme", { WEBAUTHN_RP_ID: "https://truenote.org", WEBAUTHN_ORIGINS: "https://truenote.org" }]
  ])("is unavailable in production with %s", (_label, env) => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value as string);
    expect(getWebAuthnConfig()).toBeNull();
  });
});
