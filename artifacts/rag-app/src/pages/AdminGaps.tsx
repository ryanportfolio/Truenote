import { useCallback, useEffect, useState } from "react";
import { Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { listQueryLog } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type {
  CurrentUser,
  QueryLogFilter,
  QueryLogItem
} from "@/types/api";

interface AdminGapsPageProps {
  user: CurrentUser;
}

/**
 * Content-gaps review. The read side of the trust loop: CSRs flag
 * refusals ("the knowledge base should have had this"), thumbs-down weak
 * answers, and every refusal is logged — this page is where admins see
 * those signals and decide what to upload next.
 *
 * Wrapper + inner pattern matches AdminUsersPage: the role-gate
 * early-return must not sit above hooks.
 */
export function AdminGapsPage({ user }: AdminGapsPageProps): JSX.Element {
  if (user.role === "csr") {
    return <Forbidden />;
  }
  return <AdminGapsInner user={user} />;
}

function Forbidden(): JSX.Element {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Forbidden</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Gap review is restricted to managers and above.
      </p>
    </div>
  );
}

const FILTERS: ReadonlyArray<{ value: QueryLogFilter; label: string }> = [
  { value: "flagged", label: "Flagged by CSRs" },
  { value: "refused", label: "All refusals" },
  { value: "negative", label: "Thumbs-down" },
  { value: "all", label: "Everything" }
];

const EMPTY_COPY: Record<QueryLogFilter, { title: string; hint: string }> = {
  flagged: {
    title: "No flagged gaps",
    hint: "When a CSR flags a refusal as missing content, it lands here."
  },
  refused: {
    title: "No refusals in this scope",
    hint: "Refusals are logged automatically whenever the assistant can't ground an answer."
  },
  negative: {
    title: "No thumbs-down answers",
    hint: "When a CSR thumbs-down an answer, it shows up here for review."
  },
  all: {
    title: "No questions yet",
    hint: "Once CSRs start asking, every query in this scope appears here."
  }
};

function AdminGapsInner({ user }: AdminGapsPageProps): JSX.Element {
  const [filter, setFilter] = useState<QueryLogFilter>("flagged");
  const [items, setItems] = useState<QueryLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (activeFilter: QueryLogFilter): Promise<void> => {
    setError(null);
    try {
      const response = await listQueryLog(activeFilter);
      setItems(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load queries");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    void refresh(filter);
  }, [refresh, filter]);

  // Same listener pattern as the other admin pages: refetch when the
  // super_user changes program selection (same-tab custom event +
  // cross-tab storage event).
  useEffect(() => {
    function reload(): void {
      setLoading(true);
      void refresh(filter);
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [refresh, filter]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Gaps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Questions the knowledge base couldn't answer well. Flags come from CSRs; refusals
          are logged automatically. Fill a gap by uploading the missing document.
        </p>
      </header>

      <div
        role="group"
        aria-label="Filter queries"
        className="flex flex-wrap items-center gap-2"
      >
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={
              filter === value
                ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                : "rounded-full border border-input px-3 py-1 text-xs text-muted-foreground transition-colors duration-100 ease-out hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            }
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : loading ? (
        <div
          role="status"
          className="overflow-hidden rounded-lg border border-border bg-card shadow-card"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 border-t border-border px-3 py-3 first:border-t-0"
            >
              <div className="skeleton h-4 w-64" />
              <div className="skeleton h-4 w-32" />
              <div className="skeleton h-4 w-20 rounded-full" />
              <div className="skeleton h-4 w-12" />
            </div>
          ))}
          <span className="sr-only">Loading queries…</span>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Flag}
          title={EMPTY_COPY[filter].title}
          hint={EMPTY_COPY[filter].hint}
        />
      ) : (
        <QueryTable items={items} />
      )}
    </div>
  );
}

function QueryTable({ items }: { items: QueryLogItem[] }): JSX.Element {
  // Latency is operator data, safe to show unconditionally here — the
  // whole page is manager+ (CSRs never reach this table).
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-card shadow-card">
    <table className="w-full min-w-[40rem] text-sm tabular-nums">
      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-3 py-2 font-medium">Question</th>
          <th className="px-3 py-2 font-medium">Asked</th>
          <th className="px-3 py-2 font-medium">Signals</th>
          <th className="px-3 py-2 text-right font-medium">Latency</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr
            key={item.id}
            className="border-t border-border align-top transition-colors duration-100 ease-out hover:bg-muted/40"
          >
            <td className="max-w-md px-3 py-2">
              <span className="line-clamp-2">{item.question}</span>
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
              {item.createdAt ? <RelativeTime iso={item.createdAt} /> : "—"}
            </td>
            <td className="px-3 py-2">
              <SignalBadges item={item} />
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-right text-muted-foreground">
              {item.latencyMs !== null ? `${item.latencyMs} ms` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function SignalBadges({ item }: { item: QueryLogItem }): JSX.Element {
  const badges: JSX.Element[] = [];
  if (item.flaggedMissing) {
    badges.push(
      <span
        key="flagged"
        className="inline-flex items-center gap-1 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning-foreground"
      >
        <Flag className="h-3 w-3" aria-hidden />
        Flagged
      </span>
    );
  }
  if (item.refused) {
    badges.push(
      <span
        key="refused"
        className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
      >
        Refused
      </span>
    );
  }
  if (item.feedback === -1) {
    badges.push(
      <span
        key="down"
        className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive"
      >
        <ThumbsDown className="h-3 w-3" aria-hidden />
        Down
      </span>
    );
  }
  if (item.feedback === 1) {
    badges.push(
      <span
        key="up"
        className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success"
      >
        <ThumbsUp className="h-3 w-3" aria-hidden />
        Up
      </span>
    );
  }
  if (badges.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return <div className="flex flex-wrap items-center gap-1">{badges}</div>;
}
