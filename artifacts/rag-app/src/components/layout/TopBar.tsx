import { Link, useLocation } from "wouter";
import { FileLock2 } from "lucide-react";
import { logout } from "@/lib/api";
import { cn } from "@/lib/utils";
import { hasAtLeastRole } from "@/types/api";
import type { CurrentUser, UserRole } from "@/types/api";
import { ProgramSelector } from "./ProgramSelector";
import { BrandMark } from "@/components/BrandMark";
import { ThemePicker } from "@/components/ThemePicker";

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
  supervisor: "Supervisor",
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
  const [pathname] = useLocation();
  // Super users only; the API enforces the same role on every document.
  // From lg up; below lg the sidebar carries the link, since
  // the bar has no room left at narrower widths.
  const showCompliance = hasAtLeastRole(user, "super_user");
  const complianceActive = pathname === "/compliance" || pathname.startsWith("/compliance/");

  return (
    <header className="topbar-shell">
      <div className="flex min-w-0 items-center gap-3 sm:gap-6">
        <Link
          href={homeHref}
          onPointerEnter={() => onNavigateIntent(homeHref)}
          onFocus={() => onNavigateIntent(homeHref)}
          className="brand-home-link"
        >
          <BrandMark className="h-8 w-8" />
          {/* Below 360px the mark alone shows, so the theme switch and Sign
            * out fit on one line; the wordmark stays as the link's name. */}
          <span className="sr-only flex-col min-[360px]:not-sr-only min-[360px]:flex">
            <span className="font-display text-lg font-semibold leading-none tracking-tight">
              Truenote
            </span>
            <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
              Answers with receipts
            </span>
          </span>
        </Link>
        {showCompliance && (
          <Link
            href="/compliance"
            title="Compliance"
            onPointerEnter={() => onNavigateIntent("/compliance")}
            onFocus={() => onNavigateIntent("/compliance")}
            aria-current={complianceActive ? "page" : undefined}
            className={cn(
              "btn-whisper hidden items-center gap-1.5 whitespace-nowrap px-3 py-1.5 text-sm lg:inline-flex",
              complianceActive && "font-semibold text-primary"
            )}
          >
            <FileLock2 className="h-4 w-4 shrink-0" aria-hidden />
            Compliance
          </Link>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:gap-4">
        <ProgramSelector user={user} />
        <div className="flex min-w-0 items-center gap-1.5 text-sm sm:gap-2">
          <span className="hidden text-muted-foreground sm:inline">{user.email}</span>
          <span className="hidden rounded-full bg-muted px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:inline-flex">
            {ROLE_LABEL[user.role]}
          </span>
          <ThemePicker />
          <button
            type="button"
            onClick={handleLogout}
            className="btn-whisper whitespace-nowrap px-3 py-1"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
