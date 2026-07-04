import { Link, useLocation } from "wouter";
import { Building2, FileText, Flag, MessageSquare, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { hasAtLeastRole } from "@/types/api";
import type { CurrentUser, UserRole } from "@/types/api";

interface SidebarProps {
  user: CurrentUser;
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
  { href: "/chat", label: "Chat", icon: MessageSquare, minRole: "csr" },
  { href: "/admin/documents", label: "Documents", icon: FileText, minRole: "manager" },
  { href: "/admin/gaps", label: "Gaps", icon: Flag, minRole: "manager" },
  { href: "/admin/users", label: "Users", icon: Users, minRole: "manager" },
  { href: "/admin/programs", label: "Programs", icon: Building2, minRole: "super_user" }
];

export function Sidebar({ user }: SidebarProps): JSX.Element {
  const [pathname] = useLocation();
  const items = NAV.filter((item) => hasAtLeastRole(user, item.minRole));
  return (
    // Below md the sidebar collapses to an icon rail (pure CSS — no state):
    // labels stay in the accessibility tree via sr-only, and title provides
    // the hover tooltip icon-only links need.
    <nav className="flex w-14 flex-col border-r border-border bg-secondary p-2 md:w-56 md:p-3">
      <ul className="flex flex-col gap-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                title={label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center justify-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors duration-100 ease-out md:justify-start md:px-3",
                  // Active = tint + weight: color is never the sole channel.
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <span className="sr-only md:not-sr-only">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
