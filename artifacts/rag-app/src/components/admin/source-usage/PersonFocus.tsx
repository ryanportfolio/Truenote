import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { MessageSquareText, X } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { fetchSourceUsageQuestions } from "@/lib/api";
import { cn } from "@/lib/utils";
import { answeredRate, formatPercent, plural, roleLabel } from "@/lib/sourceUsage";
import type {
  SourceUsageQuestionsResponse,
  SourceUsageResponse,
  SourceUsageUser
} from "@/types/api";
import { QuestionList } from "./QuestionList";
import { ErrorAlert, SourceName } from "./shared";

type QuestionFilter = "all" | "refused" | "negative";

interface PersonFocusProps {
  userId: string;
  /** The person's row from the usage response; null when they asked nothing in the window. */
  person: SourceUsageUser | null;
  name: string;
  totals: SourceUsageResponse["totals"];
  /** Everyone's totals for the same window, for a team comparison. Null until loaded. */
  teamTotals: SourceUsageResponse["totals"] | null;
  days: number;
  reloadKey: number;
  onClear: () => void;
  onOpenSource: (documentId: string, title: string | null) => void;
}

const FIRST_PAGE = 50;
const MAX_PAGE = 200;

/**
 * Coaching view for one person: who they are, the few facts a manager acts
 * on (answer rate against the team, refusals, thumbs-down, the sources they
 * lean on), then their exact questions with the sources each answer cited.
 */
export function PersonFocus({
  userId,
  person,
  name,
  totals,
  teamTotals,
  days,
  reloadKey,
  onClear,
  onOpenSource
}: PersonFocusProps): JSX.Element {
  const [filter, setFilter] = useState<QuestionFilter>("all");
  const pageKey = `${userId}:${days}`;
  const [page, setPage] = useState({ key: pageKey, limit: FIRST_PAGE });
  const limit = page.key === pageKey ? page.limit : FIRST_PAGE;
  const [data, setData] = useState<SourceUsageQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFilter("all");
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData((current) => (limit > FIRST_PAGE ? current : null));
    fetchSourceUsageQuestions({ windowDays: days, userId, limit })
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load the questions.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [userId, days, limit, reloadKey]);

  const visible = useMemo(() => {
    const items = data?.items ?? [];
    if (filter === "refused") return items.filter((item) => item.refused);
    if (filter === "negative") return items.filter((item) => item.feedback === -1);
    return items;
  }, [data, filter]);

  const personRate = answeredRate(totals.answered, totals.questions);
  const teamRate = teamTotals ? answeredRate(teamTotals.answered, teamTotals.questions) : null;
  const negativeCount = person?.negativeCount ?? 0;
  const loadedCounts = {
    refused: data?.items.filter((item) => item.refused).length ?? 0,
    negative: data?.items.filter((item) => item.feedback === -1).length ?? 0
  };

  return (
    <section
      aria-labelledby="person-focus-title"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="person-focus-title" className="text-xl font-semibold tracking-tight">
            {name}
          </h2>
          <p className="text-sm text-muted-foreground">
            {person ? `${roleLabel(person.role)} · ${person.email}` : "No questions in this window"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1.5 text-sm"
        >
          <X className="h-4 w-4" aria-hidden />
          Show everyone
        </button>
      </div>

      {totals.questions > 0 ? (
        <ul className="flex flex-col gap-2 text-sm leading-relaxed">
          <li>
            <span className="font-medium">{formatPercent(personRate)} answered</span>
            {teamRate !== null ? (
              <span className="text-muted-foreground">
                {" "}
                (team: {formatPercent(teamRate)}).
              </span>
            ) : (
              "."
            )}{" "}
            {plural(totals.answered, "question", "questions")} of {totals.questions} got a cited
            answer in the last {days} days.
          </li>
          {totals.refused > 0 ? (
            <li>
              <span className="font-medium">{totals.refused} refused.</span> The sources had no
              answer. A missing topic belongs in{" "}
              <Link
                href="/admin/gaps"
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Content gaps
              </Link>
              ; a question worded unlike the sources is a coaching point.
            </li>
          ) : null}
          {negativeCount > 0 ? (
            <li>
              <span className="font-medium">{negativeCount} thumbs down.</span> Open the cited
              source to check whether the source or the answer was wrong.
            </li>
          ) : null}
          {person && person.topSources.length > 0 ? (
            <li className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium">Leans on:</span>
              {person.topSources.map((source) => (
                <button
                  key={source.documentId}
                  type="button"
                  aria-haspopup="dialog"
                  onClick={() => onOpenSource(source.documentId, source.title)}
                  className="max-w-full truncate rounded-full border border-border bg-secondary px-2.5 py-0.5 text-left text-xs transition-colors duration-100 ease-out hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  title={source.title ?? "Restricted source"}
                >
                  <SourceName title={source.title} />
                  <span className="text-muted-foreground"> · {source.count}</span>
                  <span className="sr-only">, show the questions that cited it</span>
                </button>
              ))}
            </li>
          ) : null}
        </ul>
      ) : null}

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Their questions
          </h3>
          <div role="group" aria-label="Filter questions" className="flex flex-wrap gap-2">
            {(
              [
                { value: "all", label: "All" },
                { value: "refused", label: `Refused (${loadedCounts.refused})` },
                { value: "negative", label: `Thumbs down (${loadedCounts.negative})` }
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                  filter === value
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-input text-muted-foreground transition-colors duration-100 ease-out hover:bg-secondary hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <ErrorAlert message={error} />
        ) : !data ? (
          <div role="status" className="flex flex-col gap-4 rounded-lg border border-border p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <div className="skeleton h-4 w-3/4" />
                <div className="skeleton h-3 w-1/4" />
              </div>
            ))}
            <span className="sr-only">Loading questions…</span>
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title={
              filter === "refused"
                ? "No refused questions"
                : filter === "negative"
                  ? "No thumbs-down answers"
                  : "No questions in this window"
            }
            hint={
              filter === "all"
                ? "Questions appear here after this person asks in Ask."
                : "Every loaded question had a different outcome."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <QuestionList items={visible} onOpenSource={onOpenSource} />
            {data.truncated ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
                <span>
                  Showing the newest {data.items.length}. Filters apply to the loaded questions.
                </span>
                {limit < MAX_PAGE ? (
                  <button
                    type="button"
                    onClick={() => setPage({ key: pageKey, limit: MAX_PAGE })}
                    className="btn-whisper px-3 py-1 text-xs"
                  >
                    Load up to {MAX_PAGE}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
