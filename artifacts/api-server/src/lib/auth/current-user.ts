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

/**
 * Minimal shape needed by the user-admin authorization helpers. We accept
 * this instead of the full DB row so the helpers can be unit-tested with
 * plain objects, and so callers don't have to leak the full schema row
 * (which includes the password hash) into the policy layer.
 */
export interface TargetUserSummary {
  id: string;
  role: UserRole;
  programId: string | null;
}

/**
 * Can `actor` administer `target` (edit profile, change role, deactivate,
 * reset password)?
 *
 * Capability matrix (mirrored in the UI as a hint, but THIS is the
 * authoritative server-side gate):
 *   super_user       → anyone, any program
 *   senior_manager   → csr or manager in their OWN program; never another
 *                      senior_manager or super_user, never another program
 *   manager          → csr in their OWN program only
 *   csr              → no admin rights
 *
 * Self-administration is intentionally rejected here. Editing your own
 * profile happens through /api/auth (password change today; future name
 * change). Letting an admin flip their own `is_active` or `role` is a
 * lockout footgun — the last super_user could revoke themselves.
 *
 * The single helper covers PATCH / soft-DELETE / reset-password because
 * the scope check is identical for all three. The field-level policy
 * (e.g., a manager can edit name but not role) is enforced per-field in
 * the route handler on top of this gate.
 */
export function canManageUser(
  actor: CurrentUser,
  target: TargetUserSummary
): boolean {
  if (actor.id === target.id) return false;
  if (actor.role === "super_user") return true;
  // Below super_user: never touch a super_user or a senior_manager.
  if (target.role === "super_user") return false;
  if (target.role === "senior_manager") return false;
  // Below super_user: target must be in actor's program. Non-super_user
  // actors always have a non-null programId per the DB CHECK, and
  // non-super_user targets always do too — so a null on either side is
  // a runtime invariant violation. Refuse rather than wave through.
  if (actor.programId === null || target.programId === null) return false;
  if (actor.programId !== target.programId) return false;
  // Same-program scope confirmed; now role-tier rules.
  if (actor.role === "senior_manager") {
    // senior_manager → csr or manager (promote/demote within own program).
    return target.role === "csr" || target.role === "manager";
  }
  if (actor.role === "manager") {
    // manager → csr only.
    return target.role === "csr";
  }
  return false;
}

/**
 * Can `actor` create (or PATCH the role of) a user with `(targetRole,
 * targetProgramId)`?
 *
 * Mirrors canManageUser but operates on a prospective role assignment
 * rather than an existing target row — used by POST and by PATCH when
 * `role` or `programId` is being changed.
 *
 * Rules:
 *   super_user
 *     - any role
 *     - super_user → programId MUST be null (DB CHECK), otherwise reject
 *     - any other role → programId MUST be non-null
 *
 *   senior_manager
 *     - csr or manager only
 *     - programId MUST equal actor.programId
 *
 *   manager
 *     - csr only
 *     - programId MUST equal actor.programId
 *
 *   csr
 *     - never
 */
export function canAssignRole(
  actor: CurrentUser,
  targetRole: UserRole,
  targetProgramId: string | null
): boolean {
  // Universal invariant from the DB CHECK constraint: super_user has null
  // programId, every other role has non-null. Reject inconsistent pairs
  // before consulting role rules — these would 23514-fail at insert time
  // anyway, but rejecting up front gives a clean 400 instead of a 500.
  if (targetRole === "super_user" && targetProgramId !== null) return false;
  if (targetRole !== "super_user" && targetProgramId === null) return false;

  if (actor.role === "super_user") return true;
  if (actor.role === "csr") return false;
  // senior_manager / manager — target must be in actor's program.
  if (actor.programId === null) return false;
  if (targetProgramId !== actor.programId) return false;
  if (actor.role === "senior_manager") {
    return targetRole === "csr" || targetRole === "manager";
  }
  if (actor.role === "manager") {
    return targetRole === "csr";
  }
  return false;
}
