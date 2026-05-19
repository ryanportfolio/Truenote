import { Link, useLocation } from "wouter";
import { FileText, MessageSquare } from "lucide-react";
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
  { href: "/admin/documents", label: "Documents", icon: FileText, minRole: "manager" }
];

export function Sidebar({ user }: SidebarProps): JSX.Element {
  const [pathname] = useLocation();
  const items = NAV.filter((item) => hasAtLeastRole(user, item.minRole));
  return (
    <nav className="flex w-48 flex-col border-r border-border bg-card p-2">
      <ul className="flex flex-col gap-1">
        {items.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                className={cn(
                  "flex items-center gap-2 rounded px-3 py-2 text-sm",
                  active
                    ? "bg-secondary text-secondary-foreground"
                    : "text-muted-foreground hover:bg-secondary/60"
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                <span>{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
