import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOidcState,
  getOidcConfig,
  openOidcState,
  safeReturnTo,
  sealOidcState
} from "../oidc.js";

describe("OIDC config: tenant and program gates", () => {
  const tenant = "11111111-2222-4333-8444-555555555555";
  const entraIssuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  const program = "00000000-0000-4000-8000-0000000000a1";

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("OIDC_ISSUER_URL", entraIssuer);
    vi.stubEnv("OIDC_CLIENT_ID", "test-client");
    vi.stubEnv("OIDC_CLIENT_SECRET", "synthetic-test-value");
    vi.stubEnv("OIDC_REDIRECT_URI", "https://app.example.com/api/auth/oidc/callback");
    vi.stubEnv("OIDC_STATE_SECRET", "synthetic-test-state-material-at-least-32-chars");
    vi.stubEnv("OIDC_TENANT_ID", tenant);
    vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", program);
    vi.stubEnv("LOCAL_LOGIN_MODE", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("enables an Entra issuer whose path names OIDC_TENANT_ID, ignoring case", () => {
    vi.stubEnv("OIDC_TENANT_ID", tenant.toUpperCase());
    const config = getOidcConfig();
    expect(config.enabled).toBe(true);
    expect(config.tenantId).toBe(tenant);
    expect(config.allowedProgramIds).toEqual([program]);
  });

  it.each([
    ["unset", undefined],
    ["blank", "  "],
    ["another tenant", "99999999-2222-4333-8444-555555555555"]
  ])("disables an Entra issuer with OIDC_TENANT_ID %s", (_label, value) => {
    vi.stubEnv("OIDC_TENANT_ID", value);
    const config = getOidcConfig();
    expect(config.enabled).toBe(false);
    // Incomplete SSO with no explicit policy keeps local login closed.
    expect(config.localLoginMode).toBe("disabled");
  });

  it.each(["organizations", "common"])("disables the multi-tenant Entra endpoint /%s", (segment) => {
    vi.stubEnv("OIDC_ISSUER_URL", `https://login.microsoftonline.com/${segment}/v2.0`);
    vi.stubEnv("OIDC_TENANT_ID", segment);
    expect(getOidcConfig().enabled).toBe(false);
  });

  it("does not require a tenant for a non-Entra issuer", () => {
    vi.stubEnv("OIDC_ISSUER_URL", "https://idp.example.com");
    vi.stubEnv("OIDC_TENANT_ID", undefined);
    const config = getOidcConfig();
    expect(config.enabled).toBe(true);
    expect(config.tenantId).toBeNull();
  });

  it.each([undefined, "", " , "])("disables OIDC when OIDC_ALLOWED_PROGRAM_IDS is %j", (value) => {
    vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", value);
    const config = getOidcConfig();
    expect(config.enabled).toBe(false);
    expect(config.allowedProgramIds).toEqual([]);
    expect(config.localLoginMode).toBe("disabled");
  });

  it("rejects the whole program list when one entry is not a UUID", () => {
    vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", `${program},not-a-program`);
    const config = getOidcConfig();
    expect(config.enabled).toBe(false);
    expect(config.allowedProgramIds).toEqual([]);
  });

  it("lowercases and de-duplicates program ids", () => {
    const other = "00000000-0000-4000-8000-0000000000b2";
    vi.stubEnv("OIDC_ALLOWED_PROGRAM_IDS", ` ${program.toUpperCase()}, ${other},${program} `);
    expect(getOidcConfig().allowedProgramIds).toEqual([program, other]);
  });
});

describe("OIDC state", () => {
  const testSigningKey = "test-only-oidc-state-signing-material";

  it("round-trips signed PKCE state and rejects tampering", () => {
    const state = createOidcState("/admin/documents");
    const sealed = sealOidcState(state, testSigningKey);
    expect(openOidcState(sealed, testSigningKey)).toEqual(state);
    expect(openOidcState(`${sealed}x`, testSigningKey)).toBeNull();
  });

  it("blocks absolute, protocol-relative, API, and backslash redirects", () => {
    expect(safeReturnTo("https://evil.example")).toBe("/chat");
    expect(safeReturnTo("//evil.example")).toBe("/chat");
    expect(safeReturnTo("/api/admin/users")).toBe("/chat");
    expect(safeReturnTo("/\\evil.example")).toBe("/chat");
    expect(safeReturnTo("/kb/doc-1")).toBe("/kb/doc-1");
  });
});
