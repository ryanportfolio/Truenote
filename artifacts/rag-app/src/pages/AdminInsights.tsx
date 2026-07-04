import { useCallback, useEffect, useState } from "react";
import { fetchKbGaps } from "@/lib/api";
import type { CurrentUser, KbGapsResponse } from "@/types/api";
import { cn } from "@/lib/utils";
import { SELECTED_PROGRAM_CHANGED_EVENT } from "@/lib/selectedProgram";

interface AdminInsightsPageProps {
  user: CurrentUser;
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

/**
 * Content gaps: the query_log feedback loop surfaced to admins. Each row is
 * a question the KB failed — refused, thumbs-down, or explicitly flagged by
 * a CSR as "should have had this" — grouped and ranked so "which SOP do we
 * write next" is answered by evidence, not anecdote.
 */
export function AdminInsightsPage({ user: _user }: AdminInsightsPageProps): JSX.Element {
  const [windowDays, setWindowDays] = useState<number>(30);
  const [data, setData] = useState<KbGapsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      setData(await fetchKbGaps(windowDays));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load content gaps");
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh]);

  // Refetch when the super_user switches programs (same pattern as the
  // Documents page: picker fires in-tab, `storage` covers cross-tab).
  useEffect(() => {
    function reload(): void {
      setLoading(true);
      void refresh();
    }
    window.addEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
    window.addEventListener("storage", reload);
    return () => {
      window.removeEventListener(SELECTED_PROGRAM_CHANGED_EVENT, reload);
      window.removeEventListener("storage", reload);
    };
  }, [refresh]);

  const totals = data?.totals;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Content gaps</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Questions the knowledge base failed — refusals, thumbs-down answers, and questions CSRs
            flagged as missing. Each row is a document someone should write or fix.
          </p>
        </div>
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
      </header>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading…
        </p>
      ) : data?.noProgramSelected ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          Select a program from the picker in the header to see its content gaps.
        </div>
      ) : data ? (
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
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
                  <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {data.items.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground">
              No content gaps in the last {data.windowDays} days. Either the knowledge base is
              covering what CSRs ask, or there hasn't been much traffic — check the query total
              above.
            </div>
          ) : (
            <table className="w-full overflow-hidden rounded-lg border border-border bg-card text-sm shadow-card">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Question</th>
                  <th className="px-3 py-2 text-right font-medium">Asked</th>
                  <th className="px-3 py-2 text-right font-medium">Refused</th>
                  <th className="px-3 py-2 text-right font-medium">Flagged</th>
                  <th className="px-3 py-2 text-right font-medium">Thumbs down</th>
                  <th className="px-3 py-2 font-medium">Last asked</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((item) => (
                  <tr key={item.question} className="border-t border-border align-top">
                    <td className="max-w-md px-3 py-2 font-medium">{item.question}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {item.askCount}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
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
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {item.negativeCount}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {new Date(item.lastAskedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </div>
  );
}
