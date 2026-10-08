import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RelativeTime } from "@/components/RelativeTime";
import {
  shownSupervisorId,
  teamCounts,
  visibleCsrs,
  type TeamsFilter
} from "@/lib/teamsView";
import { cn } from "@/lib/utils";
import type { TeamsCsr, TeamsSupervisor } from "@/types/api";
import { FilterPill, MoveMenu, SearchField, SelectionBar } from "./shared";

/**
 * Table view: filter pills per team with counts, search, and one row per
 * CSR with a native supervisor picker. Checked rows get a sticky
 * "Assign supervisor" bar. Read-only viewers (a supervisor) get the same
 * table without checkboxes or pickers.
 */
export function TableView({
  supervisors,
  csrs,
  canEdit,
  selected,
  onSelectedChange,
  onMove
}: {
  supervisors: TeamsSupervisor[];
  csrs: TeamsCsr[];
  canEdit: boolean;
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  onMove: (csrIds: readonly string[], supervisorId: string | null) => Promise<boolean>;
}): JSX.Element {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<TeamsFilter>({ kind: "all" });
  // A CSR whose supervisor is not listed shows (and filters) as unassigned.
  const normalized = useMemo(
    () => csrs.map((csr) => ({ ...csr, supervisorId: shownSupervisorId(csr, supervisors) })),
    [csrs, supervisors]
  );
  const counts = useMemo(() => teamCounts(supervisors, csrs), [supervisors, csrs]);
  const shown = useMemo(() => visibleCsrs(normalized, filter, query), [normalized, filter, query]);
  const supervisorName = useMemo(() => new Map(supervisors.map((s) => [s.id, s.name])), [supervisors]);

  // A supervisor filter whose card is gone (program switch, deactivation) falls back to everyone.
  useEffect(() => {
    if (filter.kind === "team" && !supervisors.some((s) => s.id === filter.supervisorId)) {
      setFilter({ kind: "all" });
    }
  }, [filter, supervisors]);

  const shownSelected = shown.filter((csr) => selected.has(csr.id)).length;
  const allShownSelected = shown.length > 0 && shownSelected === shown.length;
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = shownSelected > 0 && !allShownSelected;
    }
  }, [shownSelected, allShownSelected]);

  function toggle(id: string, on: boolean): void {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onSelectedChange(next);
  }

  function toggleShown(on: boolean): void {
    const next = new Set(selected);
    for (const csr of shown) {
      if (on) next.add(csr.id);
      else next.delete(csr.id);
    }
    onSelectedChange(next);
  }

  function assignSelected(supervisorId: string | null): void {
    void onMove([...selected], supervisorId).then((ok) => {
      if (ok) onSelectedChange(new Set());
    });
  }

  const emptyText = query.trim()
    ? `No one matches "${query.trim()}".`
    : filter.kind === "unassigned"
      ? "Everyone is on a team."
      : filter.kind === "team"
        ? "No one on this team yet."
        : "No CSRs yet.";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        {canEdit ? (
          <div role="group" aria-label="Show" className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <FilterPill
              pressed={filter.kind === "all"}
              onClick={() => setFilter({ kind: "all" })}
              label="Everyone"
              count={csrs.length}
            />
            {supervisors.map((s) => (
              <FilterPill
                key={s.id}
                pressed={filter.kind === "team" && filter.supervisorId === s.id}
                onClick={() => setFilter({ kind: "team", supervisorId: s.id })}
                label={s.name}
                count={counts.bySupervisor.get(s.id) ?? 0}
              />
            ))}
            <FilterPill
              pressed={filter.kind === "unassigned"}
              onClick={() => setFilter({ kind: "unassigned" })}
              label="Unassigned"
              count={counts.unassigned}
            />
          </div>
        ) : null}
        <SearchField id={searchId} value={query} onChange={setQuery} className="w-full lg:ml-auto lg:w-72" />
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {canEdit ? (
                <th className="w-10 py-2 pl-4 pr-1">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allShownSelected}
                    disabled={shown.length === 0}
                    onChange={(e) => toggleShown(e.target.checked)}
                    aria-label="Select everyone shown"
                    className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                  />
                </th>
              ) : null}
              <th className={cn("py-2 pr-3 font-medium", canEdit ? "pl-2" : "pl-4")}>Name</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Email</th>
              <th className="px-2 py-2 font-medium sm:px-3">Supervisor</th>
              <th className="hidden py-2 pl-3 pr-4 font-medium md:table-cell">Last login</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr className="border-t border-border">
                <td colSpan={canEdit ? 5 : 4} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  {emptyText}
                </td>
              </tr>
            ) : (
              shown.map((csr) => (
                <tr
                  key={csr.id}
                  className={cn(
                    "border-t border-border transition-colors duration-100 ease-out hover:bg-muted/40",
                    selected.has(csr.id) && "bg-primary/5"
                  )}
                >
                  {canEdit ? (
                    <td className="py-2 pl-4 pr-1 align-middle">
                      <input
                        type="checkbox"
                        checked={selected.has(csr.id)}
                        onChange={(e) => toggle(csr.id, e.target.checked)}
                        aria-label={`Select ${csr.name}`}
                        className="h-4 w-4 cursor-pointer accent-primary"
                      />
                    </td>
                  ) : null}
                  <td className={cn("min-w-0 py-2 pr-3 align-middle", canEdit ? "pl-2" : "pl-4")}>
                    <span className="block break-words">{csr.name}</span>
                    {/* Narrow screens: the hidden columns fold into the name cell. */}
                    <span className="block break-all text-xs text-muted-foreground sm:hidden">{csr.email}</span>
                    <span className="block text-xs text-muted-foreground md:hidden">
                      {csr.lastLoginAt ? (
                        <>
                          Last login <RelativeTime iso={csr.lastLoginAt} />
                        </>
                      ) : (
                        "Never signed in"
                      )}
                    </span>
                  </td>
                  <td className="hidden break-all px-3 py-2 align-middle text-muted-foreground sm:table-cell">
                    {csr.email}
                  </td>
                  <td className="px-2 py-2 align-middle sm:px-3">
                    {canEdit ? (
                      <select
                        value={csr.supervisorId ?? ""}
                        onChange={(e) => void onMove([csr.id], e.target.value || null)}
                        aria-label={`Supervisor for ${csr.name}`}
                        className={cn(
                          "select-quiet w-full max-w-[8.5rem] rounded-md sm:max-w-[12rem] border py-1 pl-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring",
                          csr.supervisorId
                            ? "border-input bg-card"
                            : "border-warning/50 bg-warning/20 text-warning-foreground"
                        )}
                      >
                        {supervisors.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                        <option value="">Unassigned</option>
                      </select>
                    ) : (
                      <span className="break-words">
                        {csr.supervisorId ? supervisorName.get(csr.supervisorId) : "Unassigned"}
                      </span>
                    )}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pl-3 pr-4 align-middle text-muted-foreground md:table-cell">
                    {csr.lastLoginAt ? <RelativeTime iso={csr.lastLoginAt} /> : "Never"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canEdit && selected.size > 0 ? (
        <SelectionBar count={selected.size} onClear={() => onSelectedChange(new Set())} label="Selected CSRs">
          <MoveMenu label="Assign supervisor" supervisors={supervisors} onPick={assignSelected} />
        </SelectionBar>
      ) : null}
    </div>
  );
}
