import { STORAGE_KEY as SELECTED_PROGRAM_STORAGE_KEY } from "@/lib/selectedProgram";
import type { TeamsCsr, TeamsSupervisor } from "@/types/api";

/**
 * Pure helpers for the Teams page (/admin/teams): the saved view, search,
 * filters, counts, the optimistic move, and the spoken move summary.
 */

// ---------------------------------------------------------------------------
// View (roster or table), saved per user like the source usage view

export type TeamsView = "roster" | "table";

const VIEW_PREFIX = "truenote:teams:view:v1:";

export function teamsViewKey(userId: string): string {
  return VIEW_PREFIX + userId;
}

export function loadTeamsView(userId: string): TeamsView {
  try {
    return window.localStorage.getItem(teamsViewKey(userId)) === "table" ? "table" : "roster";
  } catch {
    return "roster";
  }
}

export function saveTeamsView(userId: string, view: TeamsView): void {
  try {
    window.localStorage.setItem(teamsViewKey(userId), view);
  } catch {
    // Private mode or a full quota: the choice lasts until reload.
  }
}

// ---------------------------------------------------------------------------
// Names

/** "Renee" from "Renee Alvarez"; the whole name when it has one word. */
export function firstName(name: string): string {
  const trimmed = name.trim();
  return trimmed.split(/\s+/)[0] || trimmed;
}

/** "Renee Alvarez's team". */
export function teamLabel(supervisorName: string): string {
  return `${supervisorName}'s team`;
}

/** Where a move lands, as words: "Renee Alvarez's team" or "Unassigned". */
export function destinationLabel(supervisor: TeamsSupervisor | null): string {
  return supervisor ? teamLabel(supervisor.name) : "Unassigned";
}

// ---------------------------------------------------------------------------
// Search and filters

/** Case-insensitive match on name or email; a blank query matches everyone. */
export function matchesSearch(csr: Pick<TeamsCsr, "name" | "email">, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return csr.name.toLocaleLowerCase().includes(q) || csr.email.toLocaleLowerCase().includes(q);
}

/** Table filter: everyone, the unassigned, or one supervisor's team (by id). */
export type TeamsFilter = { kind: "all" } | { kind: "unassigned" } | { kind: "team"; supervisorId: string };

export function matchesFilter(csr: Pick<TeamsCsr, "supervisorId">, filter: TeamsFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "unassigned") return csr.supervisorId === null;
  return csr.supervisorId === filter.supervisorId;
}

export function visibleCsrs(csrs: TeamsCsr[], filter: TeamsFilter, query: string): TeamsCsr[] {
  return csrs.filter((csr) => matchesFilter(csr, filter) && matchesSearch(csr, query));
}

export interface TeamCounts {
  /** Members per supervisor id; supervisors with no members are absent. */
  bySupervisor: Map<string, number>;
  unassigned: number;
}

/**
 * Member counts per supervisor, plus the unassigned count. A CSR whose
 * supervisor is not in the list (for example, deactivated since the last
 * load) counts as unassigned, which is how the page shows them.
 */
export function teamCounts(supervisors: TeamsSupervisor[], csrs: TeamsCsr[]): TeamCounts {
  const known = new Set(supervisors.map((s) => s.id));
  const bySupervisor = new Map<string, number>();
  let unassigned = 0;
  for (const csr of csrs) {
    if (csr.supervisorId && known.has(csr.supervisorId)) {
      bySupervisor.set(csr.supervisorId, (bySupervisor.get(csr.supervisorId) ?? 0) + 1);
    } else {
      unassigned += 1;
    }
  }
  return { bySupervisor, unassigned };
}

/** The supervisor id a CSR shows under: null when unassigned or the supervisor is unknown. */
export function shownSupervisorId(csr: Pick<TeamsCsr, "supervisorId">, supervisors: TeamsSupervisor[]): string | null {
  if (!csr.supervisorId) return null;
  return supervisors.some((s) => s.id === csr.supervisorId) ? csr.supervisorId : null;
}

// ---------------------------------------------------------------------------
// Moves

/** The CSR ids among `ids` that are not already on the destination team. */
export function idsToMove(csrs: TeamsCsr[], ids: readonly string[], supervisorId: string | null): string[] {
  const wanted = new Set(ids);
  return csrs.filter((csr) => wanted.has(csr.id) && csr.supervisorId !== supervisorId).map((csr) => csr.id);
}

/** The optimistic result of a move: the listed CSRs get the new supervisor. */
export function applyMove(csrs: TeamsCsr[], ids: readonly string[], supervisorId: string | null): TeamsCsr[] {
  const moving = new Set(ids);
  return csrs.map((csr) => (moving.has(csr.id) ? { ...csr, supervisorId } : csr));
}

/**
 * Most CSR ids one `PUT /api/admin/teams/assignments` accepts. Matches the
 * server's `MAX_TEAM_ASSIGNMENT` (artifacts/api-server/src/lib/teams.ts),
 * which rejects a longer list.
 */
export const MAX_TEAM_ASSIGNMENT = 200;

/** Split a move into requests the server accepts, in order, at most `size` ids each. */
export function assignmentChunks(ids: readonly string[], size: number = MAX_TEAM_ASSIGNMENT): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}

// The page's moves run through this queue; it lives in its own module so the
// Sources page can use it too.
export { createSerialQueue, type SerialQueue } from "@/lib/serialQueue";

/**
 * The drag keys to focus after a keyboard drop, in order: the dragged one,
 * then the same person's other one. A row dropped onto a team may leave a
 * filtered list, and a chip moved to Unassigned leaves its card, so the
 * person is found as a chip or a row instead.
 */
export function focusKeysFor(key: string): string[] {
  if (key.startsWith("row:")) return [key, `chip:${key.slice("row:".length)}`];
  if (key.startsWith("chip:")) return [key, `row:${key.slice("chip:".length)}`];
  return [key];
}

/**
 * Whether a cross-tab `storage` event should reload the page: only a change
 * to the selected program, or `null` (another tab cleared storage). Other
 * keys, such as a saved view on Sources, Usage or Teams, leave the page alone.
 */
export function storageChangeReloads(key: string | null): boolean {
  return key === null || key === SELECTED_PROGRAM_STORAGE_KEY;
}

/**
 * Which CSRs a drag moves: every checked row when the dragged row is one of
 * them, else just the dragged person.
 */
export function dragSelection(draggedId: string, selected: ReadonlySet<string>): string[] {
  return selected.has(draggedId) ? [...selected] : [draggedId];
}

/** "Jordan Reyes" for one person, "3 people" for more. */
export function peopleLabel(names: readonly string[]): string {
  if (names.length === 1) return names[0] ?? "1 person";
  return `${names.length} people`;
}

/**
 * The polite announcement after a move: "Moved Jordan Reyes to Renee
 * Alvarez's team." or "Moved 3 people to Unassigned."
 */
export function moveAnnouncement(names: readonly string[], supervisor: TeamsSupervisor | null): string {
  return `Moved ${peopleLabel(names)} to ${destinationLabel(supervisor)}.`;
}

/** Drop the selected ids that are no longer in the list (moved out of scope, deactivated). */
export function pruneSelection(selected: ReadonlySet<string>, csrs: TeamsCsr[]): Set<string> {
  const present = new Set(csrs.map((csr) => csr.id));
  return new Set([...selected].filter((id) => present.has(id)));
}

/** "1 member", "4 members". */
export function memberCount(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}
