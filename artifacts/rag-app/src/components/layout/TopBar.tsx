import { Link } from "wouter";
import { logout } from "@/lib/api";
import { hasAtLeastRole } from "@/types/api";
import type { CurrentUser, UserRole } from "@/types/api";
import { ProgramSelector } from "./ProgramSelector";
import { BrandMark } from "@/components/BrandMark";

interface TopBarProps {
  user: CurrentUser;
  onLogout: () => void;
  onNavigateIntent: (path: string) => void;
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

export function TopBar({
  user,
  onLogout,
  onNavigateIntent
}: TopBarProps): JSX.Element {
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
    <header className="topbar-shell">
      <Link
        href={homeHref}
        onPointerEnter={() => onNavigateIntent(homeHref)}
        onFocus={() => onNavigateIntent(homeHref)}
        className="brand-home-link"
      >
        <BrandMark className="h-8 w-8" />
        <span className="flex flex-col">
          <span className="font-display text-lg font-semibold leading-none tracking-tight">
            Truenote
          </span>
          <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Answers with receipts
          </span>
        </span>
      </Link>
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <ProgramSelector user={user} />
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <span className="hidden text-muted-foreground sm:inline">{user.email}</span>
          <span className="hidden rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:inline-flex">
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
