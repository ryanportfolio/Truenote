import { describe, expect, it } from "vitest";
import { CreateBody, PatchBody } from "../admin/users.js";

const PROGRAM_ID = "00000000-0000-0000-0000-0000000000aa";

function createBody(role: string) {
  return {
    email: "renee.alvarez@demo.truenote",
    name: "Renee Alvarez",
    role,
    programId: PROGRAM_ID
  };
}

describe("admin users role validation", () => {
  it("accepts supervisor on create", () => {
    const parsed = CreateBody.safeParse(createBody("supervisor"));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.role).toBe("supervisor");
  });

  it("accepts supervisor on PATCH", () => {
    const parsed = PatchBody.safeParse({ role: "supervisor" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.role).toBe("supervisor");
  });

  it("still accepts every existing role", () => {
    for (const role of ["super_user", "senior_manager", "manager", "csr"]) {
      expect(CreateBody.safeParse(createBody(role)).success, role).toBe(true);
      expect(PatchBody.safeParse({ role }).success, role).toBe(true);
    }
  });

  it("rejects an unknown role on create and PATCH", () => {
    expect(CreateBody.safeParse(createBody("admin")).success).toBe(false);
    expect(PatchBody.safeParse({ role: "admin" }).success).toBe(false);
  });
});
