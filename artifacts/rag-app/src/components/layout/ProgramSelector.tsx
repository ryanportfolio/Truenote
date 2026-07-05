import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { listPrograms } from "@/lib/api";
import { programSwatchColor } from "@/lib/programColor";
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
 * Header-mounted program picker. Renders nothing for non-super_user
 * roles — their program is fixed by the DB CHECK constraint and a
 * selector would just confuse them.
 *
 * The outer component is a thin role gate so the inner component
 * (which owns the hooks) is only mounted for super_user. This keeps
 * the hook call count stable across renders no matter how the parent
 * re-renders.
 */
export function ProgramSelector({ user }: ProgramSelectorProps): JSX.Element | null {
  if (user.role !== "super_user") return null;
  return <SuperUserProgramSelector user={user} />;
}

/**
 * The actual picker. Stores selection in localStorage (see
 * selectedProgram.ts); lib/api.ts reads from there to attach
 * X-Program-Id on every authenticated request. We dispatch a custom
 * event on writes so other in-tab components (chat, docs list) can
 * refetch when the picker changes.
 */
function SuperUserProgramSelector({ user }: ProgramSelectorProps): JSX.Element {
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
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Program</span>
      {/* Identity swatch: scope-at-a-glance for super_users. Decorative —
        * the selected NAME in the select carries the information. */}
      {selected ? (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: programSwatchColor(selected) }}
        />
      ) : null}
      <select
        value={selected}
        onChange={handleChange}
        disabled={status === "loading" || !hasPrograms}
        className="select-quiet max-w-[10rem] truncate rounded-md border border-input bg-card py-1.5 pl-2.5 pr-7 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-secondary disabled:opacity-60 sm:max-w-none"
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
