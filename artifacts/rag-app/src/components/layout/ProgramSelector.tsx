import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { listPrograms } from "@/lib/api";
import {
  getSelectedProgramId,
  setSelectedProgramId,
  SELECTED_PROGRAM_CHANGED_EVENT
} from "@/lib/selectedProgram";
import type { CurrentUser, Program } from "@/types/api";

interface ProgramSelectorProps {
  user: CurrentUser;
}

/**
 * Header-mounted program picker for super_user. Renders nothing for
 * other roles — their program is fixed by the DB CHECK constraint and
 * a selector would just confuse them.
 *
 * The selection lives in localStorage (see selectedProgram.ts) and is
 * read by lib/api.ts to attach X-Program-Id to every authenticated
 * request. We dispatch a custom event on writes so other in-tab
 * components (chat, docs list) can refetch when the picker changes.
 */
export function ProgramSelector({ user }: ProgramSelectorProps): JSX.Element | null {
  if (user.role !== "super_user") return null;

  const [programs, setPrograms] = useState<Program[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [selected, setSelected] = useState<string>(
    () => getSelectedProgramId(user.id) ?? ""
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const { items } = await listPrograms();
      setPrograms(items);
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refresh when other components (e.g. AdminPrograms create flow)
  // write to localStorage. Same-tab writes fire the custom event;
  // cross-tab writes fire the native `storage` event.
  useEffect(() => {
    function refresh(): void {
      setSelected(getSelectedProgramId(user.id) ?? "");
    }
    function reload(): void {
      void load();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener("kbase:programs-changed", reload);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("kbase:programs-changed", reload);
    };
  }, [user.id, load]);

  function handleChange(e: ChangeEvent<HTMLSelectElement>): void {
    const id = e.target.value;
    if (!id) return;
    setSelectedProgramId(user.id, id);
    setSelected(id);
  }

  const hasPrograms = programs.length > 0;

  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Program</span>
      <select
        value={selected}
        onChange={handleChange}
        disabled={status === "loading" || !hasPrograms}
        className="rounded border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
        data-testid="program-selector"
      >
        <option value="" disabled>
          {status === "loading"
            ? "Loading…"
            : status === "error"
              ? "Failed to load"
              : hasPrograms
                ? "Select a program…"
                : "No programs yet"}
        </option>
        {programs.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
