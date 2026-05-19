import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import type { CurrentUser } from "@/types/api";

interface AppShellProps {
  user: CurrentUser;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({ user, onLogout, children }: AppShellProps): JSX.Element {
  return (
    <div className="flex h-screen flex-col">
      <TopBar user={user} onLogout={onLogout} />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
