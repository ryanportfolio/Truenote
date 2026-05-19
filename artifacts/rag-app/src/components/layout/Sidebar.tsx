import { Link, useLocation } from "wouter";
import { FileText, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV: ReadonlyArray<{ href: string; label: string; icon: typeof FileText }> = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/admin/documents", label: "Documents", icon: FileText }
];

export function Sidebar(): JSX.Element {
  const [pathname] = useLocation();
  return (
    <nav className="flex w-48 flex-col border-r border-border bg-card p-2">
      <ul className="flex flex-col gap-1">
        {NAV.map(({ href, label, icon: Icon }) => {
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
