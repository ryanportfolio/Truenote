import { describe, expect, it } from "vitest";
import type { UserRole } from "@workspace/db/schema";
import {
  invitationKindFor,
  isLocalLoginAllowed,
  isSsoProgramAllowed,
  signInMethodFor
} from "../local-login-policy.js";
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

const PROGRAM = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PROGRAM = "00000000-0000-4000-8000-0000000000b2";
const ssoReady = (localLoginMode: LocalLoginMode) => ({
  enabled: true,
  allowedProgramIds: [PROGRAM],
  localLoginMode
});
const programFor = (role: UserRole) => (role === "super_user" ? null : PROGRAM);

describe("isSsoProgramAllowed", () => {
  it("allows a listed program, case-insensitively", () => {
    expect(isSsoProgramAllowed([PROGRAM], PROGRAM.toUpperCase())).toBe(true);
  });

  it("refuses an unlisted program and an account without one", () => {
    expect(isSsoProgramAllowed([PROGRAM], OTHER_PROGRAM)).toBe(false);
    expect(isSsoProgramAllowed([PROGRAM], null)).toBe(false);
  });
});

describe("signInMethodFor", () => {
  it.each(roles)("enabled gives %s a password", (role) => {
    expect(signInMethodFor(ssoReady("enabled"), role, programFor(role))).toBe("password");
  });

  it.each(roles)("break_glass gives SSO to everyone but super_user (%s)", (role) => {
    expect(signInMethodFor(ssoReady("break_glass"), role, programFor(role))).toBe(
      role === "super_user" ? "password" : "sso"
    );
  });

  it("disabled leaves a super user, who has no program, without any sign-in", () => {
    expect(signInMethodFor(ssoReady("disabled"), "super_user", null)).toBe("none");
  });

  it("gives none when OIDC is not usable", () => {
    expect(signInMethodFor({ ...ssoReady("break_glass"), enabled: false }, "csr", PROGRAM)).toBe("none");
  });

  it("gives none when the program is not allowed for SSO", () => {
    expect(signInMethodFor(ssoReady("disabled"), "csr", OTHER_PROGRAM)).toBe("none");
  });

  it("treats an unknown mode as no password sign-in", () => {
    expect(signInMethodFor(ssoReady("disable" as LocalLoginMode), "super_user", null)).toBe("none");
  });
});

describe("invitationKindFor", () => {
  it("maps each sign-in method to its invitation", () => {
    expect(invitationKindFor(ssoReady("enabled"), "csr", PROGRAM)).toBe("password_setup");
    expect(invitationKindFor(ssoReady("break_glass"), "csr", PROGRAM)).toBe("sso");
    expect(invitationKindFor(ssoReady("disabled"), "csr", OTHER_PROGRAM)).toBe("none");
  });
});
