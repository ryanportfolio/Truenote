import { useEffect, useState } from "react";
import { fetchMe } from "@/lib/api";
import type { CurrentUser } from "@/types/api";
import { ProgramSelector } from "./ProgramSelector";

export function TopBar(): JSX.Element {
  const [user, setUser] = useState<CurrentUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch((err) => {
        // Non-fatal — TopBar renders placeholder until /api/me is reachable.
        console.warn("[TopBar] fetchMe failed:", err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4">
      <div className="flex items-center gap-3">
        <div className="text-sm font-semibold tracking-tight">RAG-CSR</div>
        <span className="text-xs text-muted-foreground">Knowledge Assistant</span>
      </div>
      <div className="flex items-center gap-4">
        <ProgramSelector currentProgramId={user?.programId ?? ""} />
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{user?.email ?? "…"}</span>
          {user ? (
            <span className="rounded bg-secondary px-2 py-0.5 font-medium uppercase tracking-wide text-secondary-foreground">
              {user.role}
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}
