import type { UserRole } from "@workspace/db/schema";

export type { UserRole };

/**
 * The authenticated principal attached to every request. `programId` is
 * `null` for super_user (no program scope); every other role is guaranteed
 * by the DB CHECK constraint to have a non-null program_id. Routes must
 * still defensively handle the null branch — TS won't catch a stray
 * `user.programId!` if the runtime invariant is ever violated.
 */
export interface CurrentUser {
  id: string;
  email: string;
  role: UserRole;
  programId: string | null;
  name: string;
  mustResetPassword: boolean;
}

/**
 * Pure capability helpers. Keep these as functions of `(user, …)` so they
 * can be unit-tested without spinning up a request. Server-side enforcement
 * lives in the middleware layer; these are the truth source for both
 * server gates and (eventually) UI visibility decisions.
 */

/** Roles ordered most → least privileged. */
const ROLE_RANK: Record<UserRole, number> = {
  super_user: 100,
  senior_manager: 80,
  manager: 60,
  csr: 20
};

export function hasAtLeastRole(user: CurrentUser, minimum: UserRole): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK[minimum];
}

/**
 * Can this user act on resources scoped to `programId`?
 *
 * Super users see everything. Everyone else is bound to their own program.
 * This is the SINGLE PLACE this check should live — every route that
 * touches a program-scoped resource calls this, so we don't drift.
 */
export function canAccessProgram(
  user: CurrentUser,
  programId: string | null
): boolean {
  if (user.role === "super_user") return true;
  if (programId === null) return false;
  return user.programId === programId;
}
