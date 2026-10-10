import type { UserRole } from "@workspace/db/schema";
import type { LocalLoginMode } from "./oidc.js";

/**
 * Whether LOCAL_LOGIN_MODE lets a user with this role hold a local
 * (password) session. One rule for password login, reset-link completion
 * and session lookup, so a mode change also ends existing local sessions
 * of users the new mode no longer allows.
 *
 *   enabled     every role
 *   break_glass super_user only (the emergency account)
 *   disabled    nobody
 *
 * Activity (users.is_active) is checked by each caller, not here.
 */
export function isLocalLoginAllowed(
  mode: LocalLoginMode,
  role: UserRole
): boolean {
  switch (mode) {
    case "enabled":
      return true;
    case "break_glass":
      return role === "super_user";
    case "disabled":
      return false;
    default:
      // An unknown mode must not open local access.
      return false;
  }
}

/**
 * Which invitation an admin-created account gets, decided by the same rule
 * as isLocalLoginAllowed. "password_setup": a one-time /reset-password link
 * to choose a password. "sso": a link to the sign-in page and no password
 * token, because reset-password refuses a user the mode does not allow
 * ("Use company SSO to sign in."). The first SSO sign-in binds the identity.
 */
export type InvitationKind = "password_setup" | "sso";

export function invitationKindFor(
  mode: LocalLoginMode,
  role: UserRole
): InvitationKind {
  return isLocalLoginAllowed(mode, role) ? "password_setup" : "sso";
}
