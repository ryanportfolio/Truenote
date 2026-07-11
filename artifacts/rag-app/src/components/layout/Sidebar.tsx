import { Link, useLocation } from "wouter";
import { Activity, BookOpen, Building2, Cpu, FileText, Flag, FlaskConical, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasAtLeastRole } from "@/types/api";
import type { CurrentUser, UserRole } from "@/types/api";

interface SidebarProps {
  user: CurrentUser;
  onNavigateIntent: (path: string) => void;
}

/**
 * Nav items declare their minimum required role. The server still rejects
 * unauthorized requests (the API doesn't trust the UI), but hiding the
 * link keeps CSRs from clicking through to a 403 they can't act on.
 */
const NAV: ReadonlyArray<{
  href: string;
  label: string;
  icon: typeof FileText;
  minRole: UserRole;
}> = [
  { href: "/chat", label: "Ask", icon: MessageSquare, minRole: "csr" },
  { href: "/kb", label: "Sources", icon: BookOpen, minRole: "csr" },
  { href: "/admin/documents", label: "Documents", icon: FileText, minRole: "manager" },
  { href: "/admin/gaps", label: "Content gaps", icon: Flag, minRole: "manager" },
  { href: "/admin/users", label: "Users", icon: Users, minRole: "manager" },
  { href: "/admin/programs", label: "Programs", icon: Building2, minRole: "super_user" },
  { href: "/admin/observability", label: "Timing", icon: Activity, minRole: "super_user" },
  { href: "/admin/model-routing", label: "Models", icon: Cpu, minRole: "super_user" },
  { href: "/admin/evaluations", label: "Evaluations", icon: FlaskConical, minRole: "super_user" }
];

export function Sidebar({ user, onNavigateIntent }: SidebarProps): JSX.Element {
  const [pathname] = useLocation();
  const items = NAV.filter((item) => hasAtLeastRole(user, item.minRole));
  return (
    // Below md the sidebar collapses to an icon rail (pure CSS — no state):
    // labels stay in the accessibility tree via sr-only, and title provides
    // the hover tooltip icon-only links need.
    <nav className="sidebar-shell flex w-16 flex-col p-2 md:w-60 md:p-3">
      <ul className="flex flex-col gap-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                title={label}
                onPointerEnter={() => onNavigateIntent(href)}
                onFocus={() => onNavigateIntent(href)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "sidebar-link flex items-center justify-center gap-2.5 px-2 py-2.5 text-base md:justify-start md:px-3",
                  // Active = tint + weight: color is never the sole channel.
                  active
                    ? "sidebar-link-active font-medium text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="sidebar-icon-well">
                  <Icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                </span>
                <span className="sr-only md:not-sr-only">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
