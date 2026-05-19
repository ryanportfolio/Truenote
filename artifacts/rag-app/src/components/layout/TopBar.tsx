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
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold tracking-tight">RAG-CSR</div>
        <span className="text-xs text-muted-foreground">Knowledge Assistant</span>
      </div>
      <div className="flex items-center gap-4">
        <ProgramSelector currentProgramId={user.programId ?? ""} />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{user.email}</span>
          <span className="rounded bg-secondary px-2 py-0.5 font-medium uppercase tracking-wide text-secondary-foreground">
            {ROLE_LABEL[user.role]}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="rounded border border-border px-2 py-0.5 font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
