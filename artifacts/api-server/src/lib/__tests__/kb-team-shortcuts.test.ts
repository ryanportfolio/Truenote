import { describe, expect, it } from "vitest";
import {
  canPinForTeam,
  featuredSchema,
  MAX_FEATURED,
  teamShortcutsSchema
} from "../kb-library.js";

const A = "b60c8d5f-ff83-4516-b283-208b6b5ac2d0";
const B = "4f1f7a8e-2d1b-4c55-9a0e-6f2d9b8c1a11";

describe("team shortcut role rule", () => {
  it("lets only supervisors keep a team list", () => {
    expect(canPinForTeam("supervisor")).toBe(true);
    expect(canPinForTeam("csr")).toBe(false);
    expect(canPinForTeam("manager")).toBe(false);
    expect(canPinForTeam("senior_manager")).toBe(false);
    expect(canPinForTeam("super_user")).toBe(false);
  });
});

describe("team shortcut body", () => {
  const many = Array.from(
    { length: MAX_FEATURED + 1 },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
  );

  it("takes the same body as team pins", () => {
    expect(teamShortcutsSchema).toBe(featuredSchema);
  });

  it("accepts an ordered list up to the cap and lowercases ids", () => {
    expect(teamShortcutsSchema.safeParse({ documentIds: [] }).success).toBe(true);
    const parsed = teamShortcutsSchema.safeParse({ documentIds: [A.toUpperCase(), B] });
    expect(parsed.success && parsed.data.documentIds).toEqual([A, B]);
    expect(
      teamShortcutsSchema.safeParse({ documentIds: many.slice(0, MAX_FEATURED) }).success
    ).toBe(true);
  });

  it("rejects lists over the cap, duplicates, bad ids and extra fields", () => {
    expect(teamShortcutsSchema.safeParse({ documentIds: many }).success).toBe(false);
    expect(teamShortcutsSchema.safeParse({ documentIds: [A, A.toUpperCase()] }).success).toBe(
      false
    );
    expect(teamShortcutsSchema.safeParse({ documentIds: ["not-a-uuid"] }).success).toBe(false);
    expect(teamShortcutsSchema.safeParse({ documentIds: A }).success).toBe(false);
    expect(teamShortcutsSchema.safeParse({}).success).toBe(false);
    expect(
      teamShortcutsSchema.safeParse({ documentIds: [A], supervisorUserId: B }).success
    ).toBe(false);
  });
});
