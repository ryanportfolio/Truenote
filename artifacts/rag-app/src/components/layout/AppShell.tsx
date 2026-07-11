import type { ReactNode } from "react";
import { TopBar } from "./TopBar";
import { Sidebar } from "./Sidebar";
import { PerfAutoDetect } from "@/components/PerfAutoDetect";
import type { CurrentUser } from "@/types/api";

interface AppShellProps {
  user: CurrentUser;
  onLogout: () => void;
  children: ReactNode;
}

export function AppShell({ user, onLogout, children }: AppShellProps): JSX.Element {
  return (
    <div className="app-shell flex h-screen flex-col">
      {/* FPS auto-downgrade lives on logged-in surfaces only — the
        * logged-out auth pages are deliberately allowed their full
        * GPU-heavy brand moment. */}
      <PerfAutoDetect />
      <TopBar user={user} onLogout={onLogout} />
      <div className="relative flex flex-1 overflow-hidden">
        <Sidebar user={user} />
        <main className="app-main flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
