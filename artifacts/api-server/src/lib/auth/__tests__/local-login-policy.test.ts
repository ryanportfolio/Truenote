import { describe, expect, it } from "vitest";
import type { UserRole } from "@workspace/db/schema";
import { invitationKindFor, isLocalLoginAllowed } from "../local-login-policy.js";
import type { LocalLoginMode } from "../oidc.js";

const roles: UserRole[] = ["super_user", "manager", "supervisor", "csr"];

describe("isLocalLoginAllowed", () => {
  it.each(roles)("enabled allows %s", (role) => {
    expect(isLocalLoginAllowed("enabled", role)).toBe(true);
  });

  it.each(roles)("break_glass allows only super_user (%s)", (role) => {
    expect(isLocalLoginAllowed("break_glass", role)).toBe(role === "super_user");
  });

  it.each(roles)("disabled refuses %s", (role) => {
    expect(isLocalLoginAllowed("disabled", role)).toBe(false);
  });

  it("refuses an unknown mode", () => {
    expect(isLocalLoginAllowed("disable" as LocalLoginMode, "super_user")).toBe(false);
  });
});

describe("invitationKindFor", () => {
  it.each(roles)("enabled sends a password setup invitation to %s", (role) => {
    expect(invitationKindFor("enabled", role)).toBe("password_setup");
  });

  it.each(roles)("break_glass sends SSO invitations to everyone but super_user (%s)", (role) => {
    expect(invitationKindFor("break_glass", role)).toBe(role === "super_user" ? "password_setup" : "sso");
  });

  it.each(roles)("disabled sends an SSO invitation to %s", (role) => {
    expect(invitationKindFor("disabled", role)).toBe("sso");
  });

  it("treats an unknown mode as SSO", () => {
    expect(invitationKindFor("disable" as LocalLoginMode, "super_user")).toBe("sso");
  });
});
