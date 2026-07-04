import { Link } from "wouter";
import { logout } from "@/lib/api";
import { hasAtLeastRole } from "@/types/api";
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

  // Logo is a home link: managers live in the admin area, CSRs live in
  // chat. Role-aware target instead of a one-size-fits-all "/".
  const homeHref = hasAtLeastRole(user, "manager") ? "/admin/documents" : "/chat";

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-secondary px-4">
      {/* Brand mark: the favicon blob rendered in ink, not brand blue —
       * persistent chrome must not spend the rare-blue budget
       * (DESIGN.md: blue appears once or twice per screen, earned). */}
      <Link
        href={homeHref}
        className="-ml-1.5 flex items-center gap-2 rounded-lg px-1.5 py-1 transition-colors duration-100 ease-out hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary"
      >
        <svg viewBox="0 0 32 32" className="h-5 w-5 shrink-0" aria-hidden>
          <path
            d="M16 2c10 0 14 4 14 14s-4 14-14 14S2 26 2 16 6 2 16 2z"
            className="fill-foreground"
          />
          <text
            x="16"
            y="22"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="18"
            fontWeight="600"
            className="fill-secondary"
          >
            T
          </text>
        </svg>
        {/* Wordmark is a "distinctive element": Georgia, per DESIGN.md §Typography. */}
        <span className="font-display text-lg font-semibold tracking-tight">Truenote</span>
      </Link>
      <div className="flex items-center gap-4">
        <ProgramSelector user={user} />
        <div className="flex items-center gap-2 text-sm">
          <span className="hidden text-muted-foreground sm:inline">{user.email}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {ROLE_LABEL[user.role]}
          </span>
          <button
            type="button"
            onClick={handleLogout}
            className="btn-whisper px-3 py-1"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
