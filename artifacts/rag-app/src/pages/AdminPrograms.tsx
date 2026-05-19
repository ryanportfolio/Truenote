import { useCallback, useEffect, useState, type FormEvent } from "react";
import { createProgram, listPrograms } from "@/lib/api";
import { setSelectedProgramId } from "@/lib/selectedProgram";
import type { CurrentUser, Program } from "@/types/api";

interface AdminProgramsPageProps {
  user: CurrentUser;
}

/**
 * Super_user-only program admin: list existing programs + create a new
 * one. The server still gates POST behind requireSuperUser, so the UI
 * filter here is a UX layer — it returns a 403 element rather than
 * exposing the form for an actor whose POSTs would fail anyway.
 *
 * The role-gate wrapper conditionally mounts the inner component so
 * the hooks inside `AdminProgramsInner` are only ever invoked for
 * super_user. Without this split, swapping a logged-in user's role
 * (or rendering Forbidden first) would change the hook call count
 * across renders and crash React.
 *
 * Phase 2C.1 scope: list + create. Rename / archive / delete are
 * intentionally out of scope — deletion cascades through documents →
 * chunks → query_log and needs an explicit "danger zone" flow.
 */
export function AdminProgramsPage({ user }: AdminProgramsPageProps): JSX.Element {
  if (user.role !== "super_user") {
    return <Forbidden />;
  }
  return <AdminProgramsInner user={user} />;
}

function AdminProgramsInner({ user }: AdminProgramsPageProps): JSX.Element {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoadError(null);
    try {
      const { items } = await listPrograms();
      setPrograms(items);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load programs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function handleCreated(p: Program): void {
    // Optimistic prepend so the new program shows immediately, then
    // auto-select it so the super_user can start uploading right
    // away without a second click. Order matters: dispatch the
    // programs-changed event BEFORE writing the selection. The
    // header picker reloads its list on programs-changed; if we
    // wrote the selection first, the picker would briefly show a
    // selected value that isn't in its (stale) list.
    setPrograms((prev) => [p, ...prev]);
    window.dispatchEvent(new Event("kbase:programs-changed"));
    setSelectedProgramId(user.id, p.id);
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Programs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A program is a unit of knowledge scope. Documents, queries, and users
          belong to a program. Creating a program here lets you upload SOPs and
          assign managers to it next.
        </p>
      </header>

      <ProgramCreateForm onCreated={handleCreated} />

      {loadError ? (
        <p className="text-sm text-destructive">{loadError}</p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground">Loading programs…</p>
      ) : (
        <ProgramsList items={programs} />
      )}
    </div>
  );
}

function Forbidden(): JSX.Element {
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Forbidden</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Programs admin is restricted to super users.
      </p>
    </div>
  );
}

interface ProgramCreateFormProps {
  onCreated: (program: Program) => void;
}

function ProgramCreateForm({ onCreated }: ProgramCreateFormProps): JSX.Element {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createProgram(trimmed);
      setName("");
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create program");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded border border-border bg-card p-4"
    >
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Program name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="e.g. Acme Wireless — Tier 1"
          className="rounded border border-input bg-background px-3 py-2 text-sm"
          disabled={submitting}
        />
      </label>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={submitting || name.trim().length === 0}
          className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          {submitting ? "Creating…" : "Create program"}
        </button>
      </div>
    </form>
  );
}

interface ProgramsListProps {
  items: Program[];
}

function ProgramsList({ items }: ProgramsListProps): JSX.Element {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No programs yet. Create one above to get started.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between rounded border border-border bg-card px-4 py-3"
        >
          <div>
            <div className="text-sm font-medium">{p.name}</div>
            <div className="text-xs text-muted-foreground">
              Created {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}
            </div>
          </div>
          <code className="text-xs text-muted-foreground">{p.id.slice(0, 8)}…</code>
        </li>
      ))}
    </ul>
  );
}
