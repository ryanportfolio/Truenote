import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent
} from "react";
import { Users } from "lucide-react";
import {
  createUser,
  listPrograms,
  listUsers,
  resetUserPassword,
  updateUser
} from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type {
  CreateUserRequest,
  CurrentUser,
  Program,
  UpdateUserRequest,
  UserListItem,
  UserRole
} from "@/types/api";

interface AdminUsersPageProps {
  user: CurrentUser;
}

/**
 * Users admin. Server gates everything (canManageUser / canAssignRole);
 * the UI mirrors visibility so admins don't click into 403s, but is not
 * a security boundary.
 *
 * Wrapper + inner pattern is the same fix used by AdminProgramsPage:
 * the role-gate early-return must not sit above hooks, or React's
 * call-count invariant blows up when the user prop changes role.
 */
export function AdminUsersPage({ user }: AdminUsersPageProps): JSX.Element {
  // CSRs and below should never reach here (sidebar hides the link, the
  // server 403s the endpoints), but defend in depth.
  if (user.role === "csr") {
    return <Forbidden />;
  }
  return <AdminUsersInner user={user} />;
}

function Forbidden(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Forbidden</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Users admin is restricted to managers and above.
      </p>
    </div>
  );
}

const ROLE_LABEL: Record<UserRole, string> = {
  super_user: "Super user",
  senior_manager: "Senior manager",
  manager: "Manager",
  csr: "CSR"
};

function AdminUsersInner({ user }: AdminUsersPageProps): JSX.Element {
  const [items, setItems] = useState<UserListItem[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Lift the "just generated temp password" out of any row so it
  // persists across a refresh and is dismissable. Holds at most one
  // value at a time — surfacing two side-by-side would let an admin
  // misattribute a credential to the wrong account.
  const [credentialBanner, setCredentialBanner] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const response = await listUsers();
      setItems(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshPrograms = useCallback(async (): Promise<void> => {
    try {
      const response = await listPrograms();
      setPrograms(response.items);
    } catch {
      // Non-fatal — the create form will just have an empty program
      // dropdown. The list view doesn't need programs at all.
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshPrograms();
  }, [refresh, refreshPrograms]);

  // Re-fetch when the super_user changes their program selection (the
  // X-Program-Id header narrows the list endpoint). Same listener
  // pattern as Admin.tsx; `storage` covers cross-tab. Also catch the
  // `kbase:programs-changed` event so creating a program in the
  // Programs page reflects in the Create form's dropdown without a
  // page reload.
  useEffect(() => {
    function reloadAll(): void {
      setLoading(true);
      void refresh();
    }
    function reloadPrograms(): void {
      void refreshPrograms();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reloadAll);
    window.addEventListener("storage", reloadAll);
    window.addEventListener("kbase:programs-changed", reloadPrograms);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reloadAll);
      window.removeEventListener("storage", reloadAll);
      window.removeEventListener("kbase:programs-changed", reloadPrograms);
    };
  }, [refresh, refreshPrograms]);

  function handleCreated(item: UserListItem, tempPassword?: string): void {
    setItems((prev) => [item, ...prev]);
    if (tempPassword !== undefined) {
      setCredentialBanner({ email: item.email, password: tempPassword });
    }
  }

  function handleUpdated(item: UserListItem): void {
    setItems((prev) => prev.map((u) => (u.id === item.id ? item : u)));
  }

  function handleReset(item: UserListItem, tempPassword: string): void {
    setCredentialBanner({ email: item.email, password: tempPassword });
    // Reset bumps must_reset_password=true on the server; reflect in
    // the row so the badge shows immediately without a refetch.
    setItems((prev) =>
      prev.map((u) => (u.id === item.id ? { ...u, mustResetPassword: true } : u))
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {user.role === "super_user"
            ? "Create and manage users across all programs. Use the program picker in the header to filter the list."
            : user.role === "senior_manager"
              ? "Create and manage CSRs and managers in your program."
              : "Create and manage CSRs in your program."}
        </p>
      </header>

      {credentialBanner ? (
        <CredentialBanner
          email={credentialBanner.email}
          password={credentialBanner.password}
          onDismiss={() => setCredentialBanner(null)}
        />
      ) : null}

      <CreateUserForm
        actor={user}
        programs={programs}
        onCreated={handleCreated}
      />

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      {loading ? (
        <div role="status" className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4 shadow-card"
            >
              <div className="skeleton h-4 w-40" />
              <div className="skeleton mt-2 h-3 w-64" />
            </div>
          ))}
          <span className="sr-only">Loading users…</span>
        </div>
      ) : (
        <UsersTable
          actor={user}
          items={items}
          programs={programs}
          onUpdated={handleUpdated}
          onReset={handleReset}
        />
      )}
    </div>
  );
}

interface CredentialBannerProps {
  email: string;
  password: string;
  onDismiss: () => void;
}

/**
 * One-shot reveal of a temp password. The server returns it exactly
 * once (on create or reset); we render it prominently and rely on the
 * admin to copy + share out-of-band before dismissing. There is no
 * server endpoint that re-fetches it.
 */
function CredentialBanner({
  email,
  password,
  onDismiss
}: CredentialBannerProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail (insecure context, denied permission). Fall
      // back silently — the user can select+copy from the visible
      // <code> block.
    }
  }

  return (
    <div className="rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-240">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 space-y-2">
          <p className="font-medium">
            Temporary password for <span className="font-mono">{email}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Share this with the user through a trusted channel. They&apos;ll be
            required to change it at first login. This is shown once — copy it
            now.
          </p>
          <code className="block break-all rounded-md bg-card px-2 py-1 font-mono text-sm">
            {password}
          </code>
        </div>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="btn-whisper px-3 py-1 text-xs"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors duration-100 ease-out hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

interface CreateUserFormProps {
  actor: CurrentUser;
  programs: Program[];
  onCreated: (item: UserListItem, tempPassword?: string) => void;
}

/**
 * Inline create form. Role/program options are filtered to what the
 * actor can actually assign — the server still enforces the gate
 * (canAssignRole), so this is a UX layer.
 *
 * Capability map (matches server-side canAssignRole):
 *   super_user     → any role; programId required for non-super_user
 *                    targets, must be null for super_user
 *   senior_manager → csr or manager in own program (locked)
 *   manager        → csr in own program (locked)
 */
function CreateUserForm({
  actor,
  programs,
  onCreated
}: CreateUserFormProps): JSX.Element {
  const assignableRoles = useMemo<UserRole[]>(() => {
    if (actor.role === "super_user") {
      return ["super_user", "senior_manager", "manager", "csr"];
    }
    if (actor.role === "senior_manager") return ["manager", "csr"];
    if (actor.role === "manager") return ["csr"];
    return [];
  }, [actor.role]);

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>(
    assignableRoles[0] ?? "csr"
  );
  // For super_user actors: programId starts unset for non-super_user
  // roles (forces a deliberate pick); for super_user role it's locked
  // to null. For other actors it's locked to actor.programId.
  const [programId, setProgramId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset programId when role changes if super_user role is picked
  // (must be null) or when switching from super_user to another role
  // (the locked-null state should become an explicit pick).
  useEffect(() => {
    if (actor.role === "super_user" && role === "super_user") {
      setProgramId("");
    }
  }, [actor.role, role]);

  function resolveProgramIdForSubmit(): string | null | "MISSING" {
    if (role === "super_user") return null;
    if (actor.role !== "super_user") {
      // DB CHECK guarantees non-null for these actors.
      return actor.programId;
    }
    if (!programId) return "MISSING";
    return programId;
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = name.trim();
    if (!trimmedEmail || !trimmedName) return;
    const resolved = resolveProgramIdForSubmit();
    if (resolved === "MISSING") {
      setError("Select a program for this user");
      return;
    }
    setSubmitting(true);
    try {
      const payload: CreateUserRequest = {
        email: trimmedEmail,
        name: trimmedName,
        role,
        programId: resolved
      };
      const response = await createUser(payload);
      onCreated(response.item, response.tempPassword);
      setEmail("");
      setName("");
      setRole(assignableRoles[0] ?? "csr");
      setProgramId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setSubmitting(false);
    }
  }

  // No assignable roles means the actor's role can't reach this page —
  // belt-and-suspenders against a future role-tier addition that
  // forgets to update this map.
  if (assignableRoles.length === 0) return <></>;

  const showProgramPicker =
    actor.role === "super_user" && role !== "super_user";
  const programLocked = actor.role !== "super_user";

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <h2 className="text-sm font-semibold">Create user</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setEmail(e.target.value)
            }
            required
            maxLength={254}
            placeholder="user@example.com"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setName(e.target.value)
            }
            required
            maxLength={120}
            placeholder="Full name"
            className="rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            disabled={submitting}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Role</span>
          <select
            value={role}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              setRole(e.target.value as UserRole)
            }
            disabled={submitting || assignableRoles.length === 1}
            className="select-quiet rounded-md border border-input bg-background py-2 pl-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {assignableRoles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        {showProgramPicker ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Program</span>
            <select
              value={programId}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setProgramId(e.target.value)
              }
              disabled={submitting}
              className="select-quiet rounded-md border border-input bg-background py-2 pl-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select a program…</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : programLocked ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">Program</span>
            <input
              type="text"
              value="Your program (locked)"
              disabled
              className="rounded-md border border-input bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
            />
          </label>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        A temporary password is generated and shown once on the next screen.
        The user will be required to change it at first login.
      </p>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={
            submitting ||
            email.trim().length === 0 ||
            name.trim().length === 0
          }
          className="btn-primary px-4 py-1.5"
        >
          {submitting ? "Creating…" : "Create user"}
        </button>
      </div>
    </form>
  );
}

interface UsersTableProps {
  actor: CurrentUser;
  items: UserListItem[];
  programs: Program[];
  onUpdated: (item: UserListItem) => void;
  onReset: (item: UserListItem, tempPassword: string) => void;
}

function UsersTable({
  actor,
  items,
  programs,
  onUpdated,
  onReset
}: UsersTableProps): JSX.Element {
  // Compute the lookup map unconditionally so the hook order stays
  // stable on the empty-list render path (which used to early-return
  // above this useMemo and tripped React's hook-call invariant when
  // items toggled empty↔non-empty).
  const programNameById = useMemo<Map<string, string>>(() => {
    return new Map(programs.map((p) => [p.id, p.name]));
  }, [programs]);
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No users in this scope"
        hint="Create the first user with the form above — they get a one-time temporary password."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <UserRow
          key={item.id}
          actor={actor}
          item={item}
          programName={
            item.programId ? programNameById.get(item.programId) ?? null : null
          }
          onUpdated={onUpdated}
          onReset={onReset}
        />
      ))}
    </ul>
  );
}

interface UserRowProps {
  actor: CurrentUser;
  item: UserListItem;
  programName: string | null;
  onUpdated: (item: UserListItem) => void;
  onReset: (item: UserListItem, tempPassword: string) => void;
}

/**
 * Per-user row with inline actions. The "can I edit this user?" check
 * is a client-side mirror of the server's canManageUser. Server is
 * still the authoritative source; if the mirror drifts, the API will
 * 403 and the row's error message will surface it.
 */
function UserRow({
  actor,
  item,
  programName,
  onUpdated,
  onReset
}: UserRowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editedName, setEditedName] = useState(item.name);
  const [busy, setBusy] = useState<"none" | "save" | "active" | "reset">("none");
  const [error, setError] = useState<string | null>(null);

  const manageable = canManageUserClient(actor, item);

  async function handleSaveName(): Promise<void> {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === item.name) {
      setEditing(false);
      setEditedName(item.name);
      return;
    }
    setBusy("save");
    setError(null);
    try {
      const updated = await updateUser(item.id, { name: trimmed });
      onUpdated(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy("none");
    }
  }

  async function handleToggleActive(): Promise<void> {
    const payload: UpdateUserRequest = { isActive: !item.isActive };
    setBusy("active");
    setError(null);
    try {
      const updated = await updateUser(item.id, payload);
      onUpdated(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy("none");
    }
  }

  async function handleResetPassword(): Promise<void> {
    const ok = window.confirm(
      `Reset password for ${item.email}? Their active sessions will be revoked.`
    );
    if (!ok) return;
    setBusy("reset");
    setError(null);
    try {
      const response = await resetUserPassword(item.id);
      onReset(item, response.tempPassword);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset password");
    } finally {
      setBusy("none");
    }
  }

  return (
    <li className="rounded-lg border border-border bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {editing ? (
              <input
                type="text"
                aria-label={`Edit name for ${item.email}`}
                value={editedName}
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  setEditedName(e.target.value)
                }
                maxLength={120}
                className="rounded-md border border-input bg-background px-2 py-1 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring"
                disabled={busy === "save"}
              />
            ) : (
              <span className="text-sm font-medium">{item.name}</span>
            )}
            <span className="text-xs text-muted-foreground">{item.email}</span>
            <RoleBadge role={item.role} />
            {!item.isActive ? (
              <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                Inactive
              </span>
            ) : null}
            {item.mustResetPassword ? (
              <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs text-warning-foreground">
                Reset pending
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            {item.programId
              ? `Program: ${programName ?? item.programId.slice(0, 8) + "…"}`
              : "No program (super user)"}
            {" · "}
            {item.lastLoginAt
              ? `Last login ${new Date(item.lastLoginAt).toLocaleString()}`
              : "Never signed in"}
          </div>
        </div>
        {manageable ? (
          <div className="flex flex-wrap gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={() => void handleSaveName()}
                  disabled={busy === "save"}
                  className="btn-whisper px-3 py-1 text-xs"
                >
                  {busy === "save" ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setEditedName(item.name);
                  }}
                  disabled={busy === "save"}
                  className="btn-whisper px-3 py-1 text-xs"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="btn-whisper px-3 py-1 text-xs"
              >
                Edit name
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleToggleActive()}
              disabled={busy === "active"}
              className="btn-whisper px-3 py-1 text-xs"
            >
              {busy === "active"
                ? "Saving…"
                : item.isActive
                  ? "Deactivate"
                  : "Reactivate"}
            </button>
            <button
              type="button"
              onClick={() => void handleResetPassword()}
              disabled={busy === "reset"}
              className="btn-whisper px-3 py-1 text-xs"
            >
              {busy === "reset" ? "Resetting…" : "Reset password"}
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}
    </li>
  );
}

function RoleBadge({ role }: { role: UserRole }): JSX.Element {
  // Product-register restraint: the label carries the information; color
  // stops pretending to be a legend. Only super_user gets the accent tint.
  const tone =
    role === "super_user"
      ? "bg-primary/10 text-primary"
      : "bg-muted text-muted-foreground";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {ROLE_LABEL[role]}
    </span>
  );
}

/**
 * UI mirror of the server's canManageUser. Keep both in lockstep — the
 * server is authoritative (a drift here just causes the row to show
 * action buttons that then 403 on click), but matching is better UX.
 */
function canManageUserClient(
  actor: CurrentUser,
  target: UserListItem
): boolean {
  if (actor.id === target.id) return false;
  if (actor.role === "super_user") return true;
  if (target.role === "super_user") return false;
  if (target.role === "senior_manager") return false;
  if (actor.programId === null || target.programId === null) return false;
  if (actor.programId !== target.programId) return false;
  if (actor.role === "senior_manager") {
    return target.role === "csr" || target.role === "manager";
  }
  if (actor.role === "manager") {
    return target.role === "csr";
  }
  return false;
}
