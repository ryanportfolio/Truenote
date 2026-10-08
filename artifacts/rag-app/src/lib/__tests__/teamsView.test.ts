import { describe, expect, it } from "vitest";
import {
  applyMove,
  assignmentChunks,
  dragSelection,
  firstName,
  idsToMove,
  MAX_TEAM_ASSIGNMENT,
  matchesSearch,
  moveAnnouncement,
  pruneSelection,
  storageChangeReloads,
  teamCounts,
  teamsViewKey,
  visibleCsrs
} from "../teamsView";
import { STORAGE_KEY as SELECTED_PROGRAM_STORAGE_KEY } from "../selectedProgram";
import type { TeamsCsr, TeamsSupervisor } from "@/types/api";

const renee: TeamsSupervisor = { id: "s1", name: "Renee Alvarez", email: "renee@example.com" };
const priya: TeamsSupervisor = { id: "s2", name: "Priya Natarajan", email: "priya@example.com" };

function csr(id: string, name: string, supervisorId: string | null): TeamsCsr {
  return { id, name, email: `${name.split(" ")[0]?.toLowerCase()}@example.com`, lastLoginAt: null, supervisorId };
}

const csrs = [
  csr("c1", "Jordan Reyes", "s1"),
  csr("c2", "Aisha Bello", "s1"),
  csr("c3", "Grace Liu", "s2"),
  csr("c4", "Nadia Petrova", null),
  csr("c5", "Ben Carter", "gone")
];

describe("teamsView", () => {
  it("saves the view per user under the v1 key", () => {
    expect(teamsViewKey("u1")).toBe("truenote:teams:view:v1:u1");
  });

  it("uses the first word of a name for the roster chip", () => {
    expect(firstName("Renee Alvarez")).toBe("Renee");
    expect(firstName("  Cher ")).toBe("Cher");
  });

  it("searches name and email, case-insensitively", () => {
    expect(matchesSearch(csrs[0]!, "REYES")).toBe(true);
    expect(matchesSearch(csrs[0]!, "jordan@")).toBe(true);
    expect(matchesSearch(csrs[0]!, "grace")).toBe(false);
    expect(matchesSearch(csrs[0]!, "  ")).toBe(true);
  });

  it("counts members per supervisor and treats unknown supervisors as unassigned", () => {
    const counts = teamCounts([renee, priya], csrs);
    expect(counts.bySupervisor.get("s1")).toBe(2);
    expect(counts.bySupervisor.get("s2")).toBe(1);
    expect(counts.unassigned).toBe(2);
  });

  it("filters by team and search together", () => {
    expect(visibleCsrs(csrs, { kind: "team", supervisorId: "s1" }, "aisha").map((c) => c.id)).toEqual(["c2"]);
    expect(visibleCsrs(csrs, { kind: "unassigned" }, "").map((c) => c.id)).toEqual(["c4"]);
  });

  it("skips people already on the destination team", () => {
    expect(idsToMove(csrs, ["c1", "c3", "c4"], "s1")).toEqual(["c3", "c4"]);
    expect(idsToMove(csrs, ["c4"], null)).toEqual([]);
  });

  it("applies a move without touching anyone else", () => {
    const next = applyMove(csrs, ["c3", "c4"], "s1");
    expect(next.map((c) => c.supervisorId)).toEqual(["s1", "s1", "s1", "s1", "gone"]);
    expect(csrs[2]?.supervisorId).toBe("s2");
  });

  it("drags every checked row when the dragged row is checked", () => {
    expect(dragSelection("c1", new Set(["c1", "c3"]))).toEqual(["c1", "c3"]);
    expect(dragSelection("c2", new Set(["c1", "c3"]))).toEqual(["c2"]);
  });

  it("announces moves in plain sentences", () => {
    expect(moveAnnouncement(["Jordan Reyes"], renee)).toBe("Moved Jordan Reyes to Renee Alvarez's team.");
    expect(moveAnnouncement(["A", "B", "C"], null)).toBe("Moved 3 people to Unassigned.");
  });

  it("drops selected ids that left the list", () => {
    expect([...pruneSelection(new Set(["c1", "zz"]), csrs)]).toEqual(["c1"]);
  });

  it("caps each assignment request at the server's 200-id limit, in order", () => {
    expect(MAX_TEAM_ASSIGNMENT).toBe(200);
    const ids = Array.from({ length: 450 }, (_, i) => `c${i}`);
    const chunks = assignmentChunks(ids);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(ids);
    expect(assignmentChunks(ids.slice(0, 200)).map((c) => c.length)).toEqual([200]);
    expect(assignmentChunks(ids.slice(0, 201)).map((c) => c.length)).toEqual([200, 1]);
    expect(assignmentChunks(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
    expect(assignmentChunks([])).toEqual([]);
  });

  it("reloads on a cross-tab storage event only for the program key or a cleared storage", () => {
    expect(storageChangeReloads(SELECTED_PROGRAM_STORAGE_KEY)).toBe(true);
    expect(storageChangeReloads(null)).toBe(true);
    expect(storageChangeReloads(teamsViewKey("u1"))).toBe(false);
    expect(storageChangeReloads("truenote:usage:view:v1:u1")).toBe(false);
  });
});
