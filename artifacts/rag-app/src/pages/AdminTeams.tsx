import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Users, UsersRound } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RosterView } from "@/components/admin/teams/RosterView";
import { TableView } from "@/components/admin/teams/TableView";
import { ActionAlert, TeamsViewSwitch } from "@/components/admin/teams/shared";
import { useTeams } from "@/components/admin/teams/useTeams";
import { loadTeamsView, pruneSelection, saveTeamsView, type TeamsView } from "@/lib/teamsView";
import { hasAtLeastRole, type CurrentUser } from "@/types/api";

interface AdminTeamsPageProps {
  user: CurrentUser;
}

/**
 * Teams (/admin/teams, supervisor+): CSRs grouped under their supervisor.
 * Managers and above move people by drag and drop (Roster) or per-row
 * pickers (Table); a supervisor sees their own team, read-only. The
 * server decides both the scope and `canEdit`; the UI only mirrors it.
 *
 * Wrapper + inner pattern matches AdminUsersPage: the role-gate early
 * return must not sit above hooks.
 */
export function AdminTeamsPage({ user }: AdminTeamsPageProps): JSX.Element {
  if (user.role === "csr") {
    return (
      <div className="mx-auto max-w-5xl px-6 py-8">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
        <p className="mt-1 text-sm text-muted-foreground">Teams is restricted to supervisors and above.</p>
      </div>
    );
  }
  return <AdminTeamsInner user={user} />;
}

function AdminTeamsInner({ user }: AdminTeamsPageProps): JSX.Element {
  const teams = useTeams();
  const { data } = teams;
  const [view, setView] = useState<TeamsView>(() => loadTeamsView(user.id));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // A program switch starts over with nothing checked.
  useEffect(() => {
    setSelected(new Set());
  }, [teams.generation]);

  // People who left the list (deactivated, moved out of the program) drop out of the selection.
  const csrs = data?.csrs;
  useEffect(() => {
    if (!csrs) return;
    setSelected((prev) => {
      const next = pruneSelection(prev, csrs);
      return next.size === prev.size ? prev : next;
    });
  }, [csrs]);

  function changeView(next: TeamsView): void {
    setView(next);
    saveTeamsView(user.id, next);
    setSelected(new Set());
  }

  const supervisorViewer = user.role === "supervisor";
  const canManageUsers = hasAtLeastRole(user, "manager");
  const hasContent = data !== null && data.supervisors.length > 0 && data.csrs.length > 0;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-3xl font-semibold tracking-tight">Teams</h1>
        {hasContent && !teams.loading ? <TeamsViewSwitch view={view} onChange={changeView} /> : null}
      </header>

      {/* Move results ("Moved Jordan Reyes to Renee Alvarez's team."). */}
      <p className="sr-only" role="status" aria-live="polite">
        {teams.announcement}
      </p>

      {teams.actionError ? (
        <ActionAlert message={teams.actionError} onDismiss={teams.dismissActionError} />
      ) : null}

      {teams.loadError ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {teams.loadError}
        </p>
      ) : null}

      {teams.loading ? (
        <TeamsSkeleton />
      ) : !data ? null : data.supervisors.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No supervisors yet"
          hint="Each supervisor gets a team card here. A manager gives someone the Supervisor role on the Users page."
        >
          {canManageUsers ? (
            <Link href="/admin/users" className="btn-whisper px-3 py-1.5">
              Make someone a supervisor on the Users page
            </Link>
          ) : null}
        </EmptyState>
      ) : data.csrs.length === 0 ? (
        supervisorViewer ? (
          <EmptyState
            icon={Users}
            title="No one on your team yet"
            hint="A manager adds CSRs to your team. They show up here once assigned."
          />
        ) : (
          <EmptyState
            icon={Users}
            title="No CSRs in this program yet"
            hint="Add CSRs on the Users page, then group them under a supervisor here."
          >
            {canManageUsers ? (
              <Link href="/admin/users" className="btn-whisper px-3 py-1.5">
                Add CSRs on the Users page
              </Link>
            ) : null}
          </EmptyState>
        )
      ) : view === "table" ? (
        <TableView
          supervisors={data.supervisors}
          csrs={data.csrs}
          canEdit={data.canEdit}
          selected={selected}
          onSelectedChange={setSelected}
          onMove={teams.move}
        />
      ) : (
        <RosterView
          supervisors={data.supervisors}
          csrs={data.csrs}
          canEdit={data.canEdit}
          selected={selected}
          onSelectedChange={setSelected}
          onMove={teams.move}
        />
      )}
    </div>
  );
}

/** Roster-shaped placeholder: the CSR list card beside two team cards. */
function TeamsSkeleton(): JSX.Element {
  return (
    <div role="status">
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-hidden>
        <div className="rounded-lg border border-border bg-card p-5 shadow-card">
          <div className="skeleton h-5 w-28" />
          <div className="skeleton mt-4 h-9 w-full" />
          <div className="mt-4 flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="skeleton h-4 w-4" />
                <div className="skeleton h-4 flex-1" />
                <div className="skeleton h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border border-border bg-card p-5 shadow-card">
              <div className="skeleton h-5 w-40" />
              <div className="skeleton mt-2 h-4 w-20" />
              <div className="mt-4 flex flex-wrap gap-2">
                <div className="skeleton h-7 w-24 rounded-full" />
                <div className="skeleton h-7 w-28 rounded-full" />
                <div className="skeleton h-7 w-20 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <span className="sr-only">Loading teams…</span>
    </div>
  );
}
