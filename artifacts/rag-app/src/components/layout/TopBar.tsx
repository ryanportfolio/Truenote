import { logout } from "@/lib/api";
import type { CurrentUser, UserRole } from "@/types/api";
import { ProgramSelector } from "./ProgramSelector";

interface TopBarProps {
  user: CurrentUser;
  onLogout: () => void;
}

/**
 * Display label for a role. Keep one-word short so the chip doesn't wrap.
 * Source of truth for role NAMES (code-side) lives in the schema enum;
 * this map is purely for human-readable display.
 */
const ROLE_LABEL: Record<UserRole, string> = {
  super_user: "Super User",
  senior_manager: "Senior Mgr",
  manager: "Manager",
  csr: "CSR"
};

export function TopBar({ user, onLogout }: TopBarProps): JSX.Element {
  async function handleLogout(): Promise<void> {
    try {
      await logout();
    } finally {
      // Always clear local state — even if the server-side logout fails,
      // we don't want a stuck "logged in" UI. The next /api/me will 401
      // and re-derive the truth on next mount.
      onLogout();
    }
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-secondary px-4">
      <div className="flex items-center gap-3">
        {/* Wordmark is a "distinctive element": Georgia, per DESIGN.md §Typography. */}
        <div className="font-display text-base font-semibold tracking-tight">Truenote</div>
      </div>
      <div className="flex items-center gap-4">
        <ProgramSelector user={user} />
        <div className="flex items-center gap-2 text-xs">
          <span className="hidden text-muted-foreground sm:inline">{user.email}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 font-medium uppercase tracking-wide text-muted-foreground">
            {ROLE_LABEL[user.role]}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="btn-whisper px-2.5 py-0.5 text-xs"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
