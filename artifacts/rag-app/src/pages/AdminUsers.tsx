import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type FormEvent
} from "react";
import { FileUp, Users } from "lucide-react";
import {
  bulkCreateUsers,
  createUser,
  deleteUser,
  listPrograms,
  listUsers,
  resetUserPassword,
  updateUser
} from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { useConfirm } from "@/components/ConfirmDialog";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import { parseUserCsv, parseUserXlsx, type ParsedUserCsv } from "@/lib/userCsv";
import type {
  BulkCreateUsersResponse,
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
      <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
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

  function handleDeleted(item: UserListItem): void {
    setItems((prev) => prev.filter((u) => u.id !== item.id));
    // Drop a stale credential banner if it belonged to the deleted user —
    // a temp password for an account that no longer exists is noise.
    setCredentialBanner((prev) => (prev?.email === item.email ? null : prev));
  }

  function handleBulkImported(): void {
    setLoading(true);
    void refresh();
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Users</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {user.role === "super_user"
            ? "Manage people across programs. Choose a program above to narrow this list."
            : "Manage the people who use this program."}
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

      <BulkUserImport onImported={handleBulkImported} />

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
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}

interface BulkUserImportProps {
  onImported: () => void;
}

function BulkUserImport({ onImported }: BulkUserImportProps): JSX.Element {
  const [fileName, setFileName] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [invalidRows, setInvalidRows] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkCreateUsersResponse | null>(null);

  async function selectFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    setError(null);
    setResult(null);
    setEmails([]);
    setInvalidRows([]);
    setFileName(file?.name ?? "");
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("File must be 1 MB or smaller");
      return;
    }
    const isXlsx = file.name.toLowerCase().endsWith(".xlsx");
    try {
      let parsed: ParsedUserCsv;
      if (isXlsx) {
        // Load the xlsx parser only when an Excel file is actually
        // chosen — it ships as its own async chunk, so the CSV path and
        // non-admin bundles never pay for it.
        const { default: readXlsxFile } = await import("read-excel-file/browser");
        // readXlsxFile (v9) resolves to Sheet[]; parseUserXlsx takes the raw
        // result and reduces it to the first sheet's grid.
        parsed = parseUserXlsx(await readXlsxFile(file));
      } else {
        parsed = parseUserCsv(await file.text());
      }
      setEmails(parsed.emails);
      setInvalidRows(parsed.invalidRows);
      if (parsed.invalidRows.length > 0) {
        setError(
          `Fix invalid email row${parsed.invalidRows.length === 1 ? "" : "s"}: ${parsed.invalidRows.slice(0, 10).join(", ")}`
        );
      } else if (parsed.emails.length === 0) {
        setError("File does not contain any email addresses");
      } else if (parsed.emails.length > 100) {
        setError("File can contain at most 100 unique emails");
      }
    } catch (err) {
      // Surface the underlying reason instead of an opaque "couldn't read":
      // it distinguishes an unsupported/corrupt file or a wrong extension
      // (.xls, a Numbers export renamed .xlsx) from a parser-load failure.
      // The console line keeps the full stack for devtools.
      if (isXlsx) console.error("xlsx import failed", err);
      const detail =
        err instanceof Error && err.message ? `: ${err.message}` : "";
      setError(
        isXlsx
          ? `Could not read this Excel file${detail}`
          : "Could not read this CSV file"
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (
      emails.length === 0 ||
      emails.length > 100 ||
      invalidRows.length > 0
    ) {
      return;
    }
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await bulkCreateUsers(emails);
      setResult(response);
      onImported();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Failed to import users"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div>
        <h2 className="text-sm font-semibold">Import CSR emails</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Upload one email per row, or a CSV or Excel (.xlsx) file with an email
          column. Each user joins the current program and is emailed a private
          link to set their own password — you don&apos;t distribute anything.
        </p>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">CSV or Excel file</span>
        <input
          type="file"
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => void selectFile(event)}
          disabled={submitting}
          className="cursor-pointer rounded-md border border-input bg-background px-3 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded-full file:border file:border-border file:bg-secondary file:px-3 file:py-1 file:text-xs file:font-medium hover:file:border-foreground/30"
        />
      </label>

      {fileName && emails.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {fileName}: {emails.length} unique email{emails.length === 1 ? "" : "s"}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div
          role="status"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-sm text-warning-foreground"
        >
          <p className="font-medium">
            Added {result.created.length} user
            {result.created.length === 1 ? "" : "s"}
            {result.skippedEmails.length > 0
              ? `; skipped ${result.skippedEmails.length} existing email${result.skippedEmails.length === 1 ? "" : "s"}`
              : ""}
            .
          </p>
          {result.invitedCount > 0 ? (
            <p className="mt-1">
              Sent {result.invitedCount} invitation
              {result.invitedCount === 1 ? "" : "s"} to set a password. Each new
              user gets an email with a private link — no password to share.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={
            submitting ||
            emails.length === 0 ||
            emails.length > 100 ||
            invalidRows.length > 0
          }
          className="btn-whisper gap-2 px-4 py-2 text-sm"
        >
          <FileUp className="h-4 w-4" aria-hidden />
          {submitting ? "Adding users…" : "Add users"}
        </button>
      </div>
    </form>
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
            Copy this password now. It will not be shown again. Share it through
            a trusted channel.
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

  // Default to Manager when the actor can assign it (super_user and
  // senior_manager actors) rather than the top of the list — for a
  // super_user that would be the high-privilege super_user role, a poor
  // default for a destructive-if-wrong choice. Managers can only assign
  // csr, so they fall through to it.
  const defaultRole = useMemo<UserRole>(
    () =>
      assignableRoles.includes("manager")
        ? "manager"
        : assignableRoles[0] ?? "csr",
    [assignableRoles]
  );

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<UserRole>(defaultRole);
  // For super_user actors: programId starts unset for non-super_user
  // roles (forces a deliberate pick); for super_user role it's locked
  // to null. For other actors it's locked to actor.programId.
  const [programId, setProgramId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

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
    // Super user is the highest privilege tier — full access to every
    // program and user. Make an admin stop and confirm before minting one,
    // so it's never a slip of the role dropdown.
    if (role === "super_user") {
      const confirmed = await confirm({
        title: "Add a SUPER USER?",
        message:
          "Super users have full access to every program and every user across the entire system — the highest level of access there is.\n\nAre you sure you want to add one?",
        confirmLabel: "Add super user",
        cancelLabel: "Cancel"
      });
      if (!confirmed) return;
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
      setRole(defaultRole);
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
        They will set a new password at first sign-in.
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
          className="btn-primary px-5 py-2 text-base"
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
  onDeleted: (item: UserListItem) => void;
}

function UsersTable({
  actor,
  items,
  programs,
  onUpdated,
  onReset,
  onDeleted
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
          onDeleted={onDeleted}
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
  onDeleted: (item: UserListItem) => void;
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
  onReset,
  onDeleted
}: UserRowProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editedName, setEditedName] = useState(item.name);
  const [busy, setBusy] = useState<
    "none" | "save" | "active" | "reset" | "delete"
  >("none");
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

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
    const ok = await confirm({
      title: "Reset password?",
      message: `Reset the password for ${item.email}? Their active sessions will be revoked and they'll receive a new temporary password.`,
      confirmLabel: "Reset password",
      tone: "danger"
    });
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

  async function handleDelete(): Promise<void> {
    const ok = await confirm({
      title: "Delete user?",
      message: `Permanently delete ${item.email}? This removes the account for good and cannot be undone.`,
      confirmLabel: "Delete user",
      tone: "danger"
    });
    if (!ok) return;
    setBusy("delete");
    setError(null);
    try {
      await deleteUser(item.id);
      onDeleted(item);
      // No setBusy("none") on success: the row unmounts when the parent
      // drops it from the list, so touching state here would warn.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete user");
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
            {item.lastLoginAt ? (
              <>
                Last login <RelativeTime iso={item.lastLoginAt} />
              </>
            ) : (
              "Never signed in"
            )}
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
            {/* Delete is gated behind deactivation: an active user must be
              * deactivated first (which revokes their sessions), then the
              * destructive, irreversible delete becomes available. */}
            {!item.isActive ? (
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy === "delete"}
                className="rounded-full border border-destructive/30 px-3 py-1 text-xs font-medium text-destructive transition-colors duration-100 ease-out hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === "delete" ? "Deleting…" : "Delete"}
              </button>
            ) : null}
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
