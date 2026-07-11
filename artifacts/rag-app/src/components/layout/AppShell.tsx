import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import type { CurrentUser } from "@/types/api";

interface AppShellProps {
  user: CurrentUser;
  onLogout: () => void;
  onNavigateIntent: (path: string) => void;
  children: ReactNode;
}

export function AppShell({
  user,
  onLogout,
  onNavigateIntent,
  children
}: AppShellProps): JSX.Element {
  return (
    <ConfirmProvider>
      <div className="app-shell flex h-screen flex-col">
        <TopBar
          user={user}
          onLogout={onLogout}
          onNavigateIntent={onNavigateIntent}
        />
        <div className="relative flex flex-1 overflow-hidden">
          <Sidebar user={user} onNavigateIntent={onNavigateIntent} />
          <main className="app-main flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </ConfirmProvider>
  );
}
