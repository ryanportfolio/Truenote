import { describe, expect, it } from "vitest";
import {
  createOidcState,
  openOidcState,
  safeReturnTo,
  sealOidcState
} from "../oidc.js";

describe("OIDC state", () => {
  const secret = "0123456789abcdef0123456789abcdef";

  it("round-trips signed PKCE state and rejects tampering", () => {
    const state = createOidcState("/admin/documents");
    const sealed = sealOidcState(state, secret);
    expect(openOidcState(sealed, secret)).toEqual(state);
    expect(openOidcState(`${sealed}x`, secret)).toBeNull();
  });

  it("blocks absolute, protocol-relative, API, and backslash redirects", () => {
    expect(safeReturnTo("https://evil.example")).toBe("/chat");
    expect(safeReturnTo("//evil.example")).toBe("/chat");
    expect(safeReturnTo("/api/admin/users")).toBe("/chat");
    expect(safeReturnTo("/\\evil.example")).toBe("/chat");
    expect(safeReturnTo("/kb/doc-1")).toBe("/kb/doc-1");
  });
});
