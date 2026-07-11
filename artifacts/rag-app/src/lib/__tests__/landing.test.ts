import { describe, expect, it } from "vitest";
import { defaultLandingPath } from "../landing";
import type { CurrentUser, UserRole } from "@/types/api";

function user(role: UserRole): CurrentUser {
  return {
    id: role,
    email: `${role}@example.com`,
    role,
    programId: role === "super_user" ? null : "program-1",
    name: role,
    mustResetPassword: false
  };
}

describe("defaultLandingPath", () => {
  it.each(["manager", "senior_manager", "super_user"] as const)(
    "lands %s on Documents",
    (role) => {
      expect(defaultLandingPath(user(role))).toBe("/admin/documents");
    }
  );

  it("keeps CSRs on Ask", () => {
    expect(defaultLandingPath(user("csr"))).toBe("/chat");
  });
});

