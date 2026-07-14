import { describe, expect, it } from "vitest";
import {
  createOidcState,
  openOidcState,
  safeReturnTo,
  sealOidcState
} from "../oidc.js";

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
