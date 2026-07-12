import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Flag, ThumbsDown, ThumbsUp } from "lucide-react";
import { fetchKbGaps, listQueryLog } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { cn } from "@/lib/utils";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";
import type {
  CurrentUser,
  KbGapsResponse,
  QueryLogFilter,
  QueryLogItem
} from "@/types/api";

interface AdminGapsPageProps {
  user: CurrentUser;
}

/**
 * Content gaps — the read side of the trust loop, consolidated (2026-07)
 * from two parallel-built surfaces:
 *
 *   1. "Top gaps" (was /admin/insights): questions grouped + ranked over a
 *      7/30/90-day window with traffic totals — answers "which SOP do we
 *      write next" by evidence. Feeds from /api/admin/insights/kb-gaps.
 *   2. "Review queue" (original /admin/gaps): row-level, filterable,
 *      newest-first — answers "what happened on this exact query". Feeds
 *      from /api/admin/queries.
 *
 * Both endpoints stay: they serve different shapes (aggregate vs rows) to
 * different sections of this one page.
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

const WINDOW_OPTIONS = [7, 30, 90] as const;

const FILTERS: ReadonlyArray<{ value: QueryLogFilter; label: string }> = [
  { value: "flagged", label: "Flagged by CSRs" },
  { value: "refused", label: "All refusals" },
  { value: "negative", label: "Thumbs-down" },
  { value: "all", label: "Everything" }
];

const EMPTY_COPY: Record<QueryLogFilter, { title: string; hint: string }> = {
  flagged: {
    title: "No flagged gaps",
    hint: "A CSR marked a question as missing content."
  },
  refused: {
    title: "No refusals in this scope",
    hint: "The documents did not support an answer."
  },
  negative: {
    title: "No thumbs-down answers",
    hint: "A CSR gave an answer a thumbs-down."
  },
  all: {
    title: "No questions yet",
    hint: "Questions appear here after a CSR asks."
  }
};

function AdminGapsInner({ user: _user }: AdminGapsPageProps): JSX.Element {
  // Top gaps (aggregated) section state.
  const [windowDays, setWindowDays] = useState<number>(30);
  const [gaps, setGaps] = useState<KbGapsResponse | null>(null);
  const [gapsLoading, setGapsLoading] = useState(true);
  const [gapsError, setGapsError] = useState<string | null>(null);

  // Review queue (row-level) section state.
  const [filter, setFilter] = useState<QueryLogFilter>("flagged");
  const [items, setItems] = useState<QueryLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshGaps = useCallback(async (): Promise<void> => {
    setGapsError(null);
    try {
      setGaps(await fetchKbGaps(windowDays));
    } catch (err) {
      setGapsError(err instanceof Error ? err.message : "Failed to load top gaps");
    } finally {
      setGapsLoading(false);
    }
  }, [windowDays]);

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
    setGapsLoading(true);
    void refreshGaps();
  }, [refreshGaps]);

  useEffect(() => {
    setLoading(true);
    void refresh(filter);
  }, [refresh, filter]);

  // Same listener pattern as the other admin pages: refetch when the
  // super_user changes program selection (same-tab custom event +
  // cross-tab storage event). Both sections reload.
  useEffect(() => {
    function reload(): void {
      setGapsLoading(true);
      setLoading(true);
      void refreshGaps();
      void refresh(filter);
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [refreshGaps, refresh, filter]);

  const totals = gaps?.totals;
  const noProgramSelected = gaps?.noProgramSelected === true;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Content gaps</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Questions the documents did not answer. Flags and refusals appear here. Add the missing
          document to close a gap.
        </p>
      </header>

      {noProgramSelected ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Choose a program to see its content gaps.
        </div>
      ) : (
        <>
          {/* ---- Top gaps: grouped + ranked over a window ---- */}
          <section className="flex flex-col gap-3" aria-label="Top gaps">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Top gaps
              </h2>
              <div
                role="group"
                aria-label="Time window"
                className="flex overflow-hidden rounded-lg border border-border"
              >
                {WINDOW_OPTIONS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    aria-pressed={windowDays === days}
                    onClick={() => setWindowDays(days)}
                    className={cn(
                      "px-3 py-1.5 text-xs font-medium transition-colors duration-100",
                      windowDays === days
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    {days}d
                  </button>
                ))}
              </div>
            </div>

            {gapsError ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {gapsError}
              </p>
            ) : gapsLoading ? (
              <div role="status" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="skeleton h-16 rounded-lg" />
                ))}
                <span className="sr-only">Loading top gaps…</span>
              </div>
            ) : gaps ? (
              <>
                {totals ? (
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {[
                      { label: "Queries", value: totals.queries },
                      { label: "Refused", value: totals.refused },
                      { label: "Flagged missing", value: totals.flaggedMissing },
                      { label: "Thumbs down", value: totals.negativeFeedback }
                    ].map(({ label, value }) => (
                      <div
                        key={label}
                        className="rounded-lg border border-border bg-card px-3 py-2 shadow-card"
                      >
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                          {label}
                        </dt>
                        <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {gaps.items.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                    No repeated gaps in the last {gaps.windowDays} days. The queue below has each
                    query.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-3 py-2 font-medium">Question</th>
                          <th className="px-3 py-2 text-right font-medium">Asked</th>
                          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Refused</th>
                          <th className="px-3 py-2 text-right font-medium">Flagged</th>
                          <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Thumbs down</th>
                          <th className="hidden px-3 py-2 font-medium sm:table-cell">Last asked</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gaps.items.map((item) => (
                          <tr key={item.question} className="border-t border-border align-top">
                            <td className="max-w-md px-3 py-2 font-medium">
                              <span className="line-clamp-2">{item.question}</span>
                              <span className="mt-1 block text-xs font-normal text-muted-foreground md:hidden">
                                Refused {item.refusedCount} · Thumbs down {item.negativeCount} · {new Date(item.lastAskedAt).toLocaleDateString()}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                              {item.askCount}
                            </td>
                            <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                              {item.refusedCount}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {item.flaggedCount > 0 ? (
                                <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning-foreground">
                                  {item.flaggedCount}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">0</span>
                              )}
                            </td>
                            <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                              {item.negativeCount}
                            </td>
                            <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground sm:table-cell">
                              {new Date(item.lastAskedAt).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            ) : null}
          </section>

          {/* ---- Review queue: row-level, filterable, newest first ---- */}
          <section className="flex flex-col gap-3" aria-label="Review queue">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Review queue
            </h2>
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
          </section>
        </>
      )}
    </div>
  );
}

function QueryTable({ items }: { items: QueryLogItem[] }): JSX.Element {
  // Latency is operator data, safe to show unconditionally here — the
  // whole page is manager+ (CSRs never reach this table).
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
    <table className="w-full text-sm tabular-nums">
      <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
        <tr>
          <th className="px-3 py-2 font-medium">Question</th>
          <th className="hidden px-3 py-2 font-medium sm:table-cell">Asked</th>
          <th className="hidden px-3 py-2 font-medium sm:table-cell">Signals</th>
          <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Latency</th>
          <th className="px-3 py-2">
            <span className="sr-only">Actions</span>
          </th>
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
              <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                {item.createdAt ? <RelativeTime iso={item.createdAt} /> : "Time unavailable"}
                {item.latencyMs !== null ? ` · ${item.latencyMs} ms` : ""}
              </span>
              <div className="mt-1 sm:hidden">
                <SignalBadges item={item} />
              </div>
            </td>
            <td className="hidden whitespace-nowrap px-3 py-2 text-muted-foreground sm:table-cell">
              {item.createdAt ? <RelativeTime iso={item.createdAt} /> : "—"}
            </td>
            <td className="hidden px-3 py-2 sm:table-cell">
              <SignalBadges item={item} />
            </td>
            <td className="hidden whitespace-nowrap px-3 py-2 text-right text-muted-foreground sm:table-cell">
              {item.latencyMs !== null ? `${item.latencyMs} ms` : "—"}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-right">
              {/* Close the loop: gap → upload form with the question as the
                * suggested document title. */}
              <Link
                href={`/admin/documents?title=${encodeURIComponent(item.question.slice(0, 120))}`}
                className="btn-whisper px-2.5 py-1 text-xs"
              >
                Fill this gap
              </Link>
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
