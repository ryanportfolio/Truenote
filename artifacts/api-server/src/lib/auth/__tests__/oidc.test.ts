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

  describe.each([
    ["global v2.0", `https://login.microsoftonline.com/${tenant}/v2.0`],
    ["global alias login.microsoft.com", `https://login.microsoft.com/${tenant}/v2.0`],
    ["global alias login.windows.net", `https://login.windows.net/${tenant}/v2.0`],
    ["v1.0 global and US Government", `https://sts.windows.net/${tenant}/`],
    ["US Government v2.0", `https://login.microsoftonline.us/${tenant}/v2.0`],
    ["US Government legacy host", `https://login-us.microsoftonline.com/${tenant}/v2.0`],
    ["China v2.0", `https://login.partner.microsoftonline.cn/${tenant}/v2.0`],
    ["China legacy login host", `https://login.chinacloudapi.cn/${tenant}/v2.0`],
    ["China v1.0", `https://sts.chinacloudapi.cn/${tenant}/`],
    ["uppercase host with a trailing dot", `https://STS.WINDOWS.NET./${tenant}/`]
  ])("Entra issuer host: %s", (_label, issuer) => {
    beforeEach(() => vi.stubEnv("OIDC_ISSUER_URL", issuer));

    it("is enabled when OIDC_TENANT_ID matches the issuer tenant", () => {
      vi.stubEnv("OIDC_TENANT_ID", tenant.toUpperCase());
      expect(getOidcConfig().enabled).toBe(true);
    });

    it.each([
      ["unset", undefined],
      ["another tenant", "99999999-2222-4333-8444-555555555555"]
    ])("is disabled when OIDC_TENANT_ID is %s", (_tenantLabel, value) => {
      vi.stubEnv("OIDC_TENANT_ID", value);
      expect(getOidcConfig().enabled).toBe(false);
    });
  });

  it.each([
    ["sts.windows.net", "common"],
    ["login.microsoftonline.us", "organizations"],
    ["login.partner.microsoftonline.cn", "consumers"]
  ])("disables the multi-tenant endpoint %s/%s", (host, segment) => {
    vi.stubEnv("OIDC_ISSUER_URL", `https://${host}/${segment}/v2.0`);
    vi.stubEnv("OIDC_TENANT_ID", segment);
    expect(getOidcConfig().enabled).toBe(false);
  });

  // Rule: Entra hosts match by exact hostname, never by prefix or suffix. A
  // look-alike host is a different issuer, which discovery and signature
  // checks pin to that host; it is not Entra, so it needs no tenant.
  it.each([
    "https://login.microsoftonline.com.evil.example/common/v2.0",
    "https://evilsts.windows.net/common/",
    "https://sts.windows.net.evil.example/common/"
  ])("treats look-alike host %s as non-Entra", (issuer) => {
    vi.stubEnv("OIDC_ISSUER_URL", issuer);
    vi.stubEnv("OIDC_TENANT_ID", undefined);
    expect(getOidcConfig().enabled).toBe(true);
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
