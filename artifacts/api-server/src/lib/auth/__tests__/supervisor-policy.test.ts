import { describe, expect, it } from "vitest";
import {
  canAssignRole,
  canManageUser,
  hasAtLeastRole,
  type CurrentUser,
  type UserRole
} from "../current-user.js";

const PROGRAM_A = "program-a";
const PROGRAM_B = "program-b";

function user(id: string, role: UserRole, programId: string | null = PROGRAM_A): CurrentUser {
  return { id, email: `${id}@example.com`, role, programId, name: id, mustResetPassword: false };
}

function target(id: string, role: UserRole, programId: string | null = PROGRAM_A) {
  return { id, role, programId };
}

const ROLES: UserRole[] = ["csr", "supervisor", "manager", "senior_manager", "super_user"];

describe("role rank", () => {
  it("ranks supervisor above csr and below manager", () => {
    const supervisor = user("sup", "supervisor");
    expect(hasAtLeastRole(supervisor, "csr")).toBe(true);
    expect(hasAtLeastRole(supervisor, "supervisor")).toBe(true);
    expect(hasAtLeastRole(supervisor, "manager")).toBe(false);
    expect(hasAtLeastRole(user("csr", "csr"), "supervisor")).toBe(false);
    expect(hasAtLeastRole(user("mgr", "manager"), "supervisor")).toBe(true);
  });

  it("keeps the full order csr < supervisor < manager < senior_manager < super_user", () => {
    ROLES.forEach((role, i) => {
      const actor = user(role, role, role === "super_user" ? null : PROGRAM_A);
      ROLES.forEach((minimum, j) => {
        expect(hasAtLeastRole(actor, minimum)).toBe(i >= j);
      });
    });
  });
});

describe("canAssignRole", () => {
  it("lets a manager assign csr or supervisor in their own program only", () => {
    const manager = user("mgr", "manager");
    expect(canAssignRole(manager, "csr", PROGRAM_A)).toBe(true);
    expect(canAssignRole(manager, "supervisor", PROGRAM_A)).toBe(true);
    expect(canAssignRole(manager, "manager", PROGRAM_A)).toBe(false);
    expect(canAssignRole(manager, "senior_manager", PROGRAM_A)).toBe(false);
    expect(canAssignRole(manager, "super_user", null)).toBe(false);
    expect(canAssignRole(manager, "supervisor", PROGRAM_B)).toBe(false);
  });

  it("lets a senior manager assign csr, supervisor or manager in their own program only", () => {
    const senior = user("sm", "senior_manager");
    expect(canAssignRole(senior, "csr", PROGRAM_A)).toBe(true);
    expect(canAssignRole(senior, "supervisor", PROGRAM_A)).toBe(true);
    expect(canAssignRole(senior, "manager", PROGRAM_A)).toBe(true);
    expect(canAssignRole(senior, "senior_manager", PROGRAM_A)).toBe(false);
    expect(canAssignRole(senior, "super_user", null)).toBe(false);
    expect(canAssignRole(senior, "supervisor", PROGRAM_B)).toBe(false);
    expect(canAssignRole(senior, "manager", PROGRAM_B)).toBe(false);
  });

  it("never lets a supervisor or csr assign any role", () => {
    for (const actor of [user("sup", "supervisor"), user("csr", "csr")]) {
      for (const role of ROLES) {
        expect(canAssignRole(actor, role, role === "super_user" ? null : PROGRAM_A)).toBe(false);
      }
    }
  });

  it("lets a super user assign supervisor in any program", () => {
    const admin = user("root", "super_user", null);
    expect(canAssignRole(admin, "supervisor", PROGRAM_B)).toBe(true);
    expect(canAssignRole(admin, "supervisor", null)).toBe(false);
  });
});

describe("canManageUser", () => {
  it("lets a manager manage csrs and supervisors in their own program only", () => {
    const manager = user("mgr", "manager");
    expect(canManageUser(manager, target("c1", "csr"))).toBe(true);
    expect(canManageUser(manager, target("s1", "supervisor"))).toBe(true);
    expect(canManageUser(manager, target("m2", "manager"))).toBe(false);
    expect(canManageUser(manager, target("sm", "senior_manager"))).toBe(false);
    expect(canManageUser(manager, target("root", "super_user", null))).toBe(false);
    expect(canManageUser(manager, target("s2", "supervisor", PROGRAM_B))).toBe(false);
    expect(canManageUser(manager, target("c2", "csr", PROGRAM_B))).toBe(false);
    expect(canManageUser(manager, target(manager.id, "manager"))).toBe(false);
  });

  it("lets a senior manager manage csrs, supervisors and managers in their own program only", () => {
    const senior = user("sm", "senior_manager");
    expect(canManageUser(senior, target("c1", "csr"))).toBe(true);
    expect(canManageUser(senior, target("s1", "supervisor"))).toBe(true);
    expect(canManageUser(senior, target("m1", "manager"))).toBe(true);
    expect(canManageUser(senior, target("sm2", "senior_manager"))).toBe(false);
    expect(canManageUser(senior, target("root", "super_user", null))).toBe(false);
    expect(canManageUser(senior, target("s2", "supervisor", PROGRAM_B))).toBe(false);
    expect(canManageUser(senior, target("m2", "manager", PROGRAM_B))).toBe(false);
    expect(canManageUser(senior, target(senior.id, "senior_manager"))).toBe(false);
  });

  it("never lets a supervisor or csr manage anyone, their own team included", () => {
    for (const actor of [user("sup", "supervisor"), user("csr", "csr")]) {
      for (const role of ROLES) {
        expect(canManageUser(actor, target("t", role, role === "super_user" ? null : PROGRAM_A))).toBe(false);
      }
      expect(canManageUser(actor, target(actor.id, actor.role))).toBe(false);
    }
  });
});
