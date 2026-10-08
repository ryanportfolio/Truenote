import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowLeft, MessageSquareText } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { fetchSourceUsage, fetchSourceUsageQuestions } from "@/lib/api";
import {
  answeredRate,
  barWidth,
  firstName,
  formatCategoryPaths,
  formatPercent,
  percentOf,
  plural,
  roleLabel
} from "@/lib/sourceUsage";
import type {
  SourceUsageQuestion,
  SourceUsageQuestionsResponse,
  SourceUsageResponse,
  SourceUsageSource,
  SourceUsageUser
} from "@/types/api";
import { QuestionList } from "./QuestionList";
import { Kpi } from "./UsageKpis";
import { CategoryPath, ErrorAlert, InlineBar, RoleBadge, SourceOpener } from "./shared";

/** Everyone's numbers for the same window, for the team comparison. */
export interface TeamNumbers {
  totals: SourceUsageResponse["totals"];
  users: readonly SourceUsageUser[];
}

interface PersonFocusProps {
  userId: string;
  /** Identity from the response (any window); null only if the server sent none. */
  identity: SourceUsageResponse["person"];
  /** Fallback name while identity is missing. */
  name: string;
  /** The person's row in this window; null when they asked nothing. */
  row: SourceUsageUser | null;
  totals: SourceUsageResponse["totals"];
  /** Sources this person's answers cited, ranked by citations. */
  sources: readonly SourceUsageSource[];
  team: TeamNumbers | null;
  categoryPaths: ReadonlyMap<string, string[]>;
  days: number;
  reloadKey: number;
  onClear: () => void;
  onOpenSource: (documentId: string, title: string | null) => void;
  onWiderWindow: (() => void) | null;
}

/** One request covers the whole window for nearly everyone; the server caps at 200. */
const QUESTION_LIMIT = 200;
const RELIES_ON_ROWS = 8;
const GROUP_ROWS = 5;
const ALL_ROWS = 10;

/**
 * Coaching profile for one person, summary first: who they are, their
 * numbers against the team, the sources their answers rely on, then the
 * questions to review grouped by problem (refused, thumbs down), then every
 * question they asked.
 */
export function PersonFocus({
  userId,
  identity,
  name,
  row,
  totals,
  sources,
  team,
  categoryPaths,
  days,
  reloadKey,
  onClear,
  onOpenSource,
  onWiderWindow
}: PersonFocusProps): JSX.Element {
  const [data, setData] = useState<SourceUsageQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasQuestions = totals.questions > 0;
  const shortName = firstName(name);

  useEffect(() => {
    if (!hasQuestions) return;
    let cancelled = false;
    setError(null);
    setData(null);
    fetchSourceUsageQuestions({ windowDays: days, userId, limit: QUESTION_LIMIT })
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
  }, [userId, days, reloadKey, hasQuestions]);

  const groups = useMemo(() => {
    const items = data?.items ?? [];
    return {
      refused: items.filter((item) => item.refused),
      negative: items.filter((item) => item.feedback === -1)
    };
  }, [data]);

  const negativeCount = row?.negativeCount ?? 0;
  const teamNegatives = team ? team.users.reduce((sum, user) => sum + user.negativeCount, 0) : 0;
  const teamAverage =
    team && team.totals.activeUsers > 0
      ? Math.round(team.totals.questions / team.totals.activeUsers)
      : null;
  const teamAnswered = team ? answeredRate(team.totals.answered, team.totals.questions) : null;
  const teamRefused = team ? percentOf(team.totals.refused, team.totals.questions) : null;
  const teamNegative = team ? percentOf(teamNegatives, team.totals.questions) : null;

  return (
    <section aria-labelledby="person-focus-title" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Back to everyone
        </button>
        <div className="flex flex-wrap items-center gap-3">
          <h2
            id="person-focus-title"
            tabIndex={-1}
            className="rounded-sm text-2xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            {name}
          </h2>
          {identity ? <RoleBadge>{roleLabel(identity.role)}</RoleBadge> : null}
          {identity?.email ? (
            <span className="min-w-0 break-all text-sm text-muted-foreground">{identity.email}</span>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Review the questions and sources behind {shortName}'s answers in the last {days} days.
          {row?.lastAskedAt ? (
            <>
              {" Last asked "}
              <RelativeTime iso={row.lastAskedAt} />.
            </>
          ) : null}
        </p>
      </div>

      {!hasQuestions ? (
        <NoQuestions
          userId={userId}
          name={name}
          shortName={shortName}
          days={days}
          reloadKey={reloadKey}
          onWiderWindow={onWiderWindow}
        />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Questions" value={totals.questions}>
              {teamAverage !== null ? `Team average ${teamAverage} per person.` : "Asked in this window."}
            </Kpi>
            <Kpi label="Answered" value={formatPercent(answeredRate(totals.answered, totals.questions))}>
              {teamAnswered !== null ? `Team ${formatPercent(teamAnswered)}. ` : ""}
              {totals.answered} of {totals.questions} got a cited answer.
            </Kpi>
            <Kpi label="Refused" value={totals.refused}>
              {percentOf(totals.refused, totals.questions)} of questions
              {teamRefused !== null ? `. Team ${teamRefused}.` : "."}
            </Kpi>
            <Kpi label="Thumbs down" value={negativeCount}>
              {percentOf(negativeCount, totals.questions)} of questions
              {teamNegative !== null ? `. Team ${teamNegative}.` : "."}
            </Kpi>
          </dl>

          <div className="grid gap-6 lg:grid-cols-2">
            <ReliesOn
              shortName={shortName}
              days={days}
              sources={sources}
              categoryPaths={categoryPaths}
              onOpenSource={onOpenSource}
            />

            <section
              aria-labelledby="questions-to-review-title"
              className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card"
            >
              <div>
                <h3 id="questions-to-review-title" className="text-base font-semibold tracking-tight">
                  Questions to review
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Exact questions from {shortName}'s conversations.
                </p>
              </div>
              {error ? (
                <ErrorAlert message={error} />
              ) : !data ? (
                <QuestionsSkeleton />
              ) : (
                <>
                  <QuestionGroup
                    id="refused"
                    label="Refused"
                    total={totals.refused}
                    items={groups.refused}
                    empty="No refused questions in this window."
                    onOpenSource={onOpenSource}
                    note={
                      totals.refused > 0 ? (
                        <>
                          A missing topic belongs in{" "}
                          <Link
                            href="/admin/gaps"
                            className="font-medium text-primary underline-offset-2 hover:underline"
                          >
                            Content gaps
                          </Link>
                          ; a question worded unlike the sources is a coaching point.
                        </>
                      ) : null
                    }
                  />
                  <QuestionGroup
                    id="negative"
                    label="Thumbs down"
                    total={negativeCount}
                    items={groups.negative}
                    empty="No thumbs-down answers in this window."
                    onOpenSource={onOpenSource}
                    note={
                      negativeCount > 0
                        ? "Open the cited source to check whether the source or the answer was wrong."
                        : null
                    }
                  />
                </>
              )}
            </section>
          </div>

          <AllQuestions
            total={totals.questions}
            shortName={shortName}
            data={data}
            error={error}
            onOpenSource={onOpenSource}
          />
        </>
      )}
    </section>
  );
}

/**
 * Empty person view. "Show the last 90 days" only helps when the person asked
 * something in that window, so a shorter window checks the 90-day count first
 * and offers the button with the number, or says they have asked nothing.
 */
function NoQuestions({
  userId,
  name,
  shortName,
  days,
  reloadKey,
  onWiderWindow
}: {
  userId: string;
  name: string;
  shortName: string;
  days: number;
  reloadKey: number;
  onWiderWindow: (() => void) | null;
}): JSX.Element {
  // null while checking; -1 when the check failed (offer the button anyway).
  const [widerCount, setWiderCount] = useState<number | null>(days >= 90 ? 0 : null);

  useEffect(() => {
    if (days >= 90) return;
    let cancelled = false;
    setWiderCount(null);
    fetchSourceUsage({ windowDays: 90, userId })
      .then((result) => {
        if (!cancelled) setWiderCount(result.totals.questions);
      })
      .catch(() => {
        if (!cancelled) setWiderCount(-1);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, days, reloadKey]);

  const neverAsked = widerCount === 0;
  const canWiden = onWiderWindow !== null && widerCount !== null && widerCount !== 0;
  return (
    <EmptyState
      icon={MessageSquareText}
      title={
        neverAsked
          ? `${name} has not asked any questions yet`
          : `${name} asked no questions in the last ${days} days`
      }
      hint={
        neverAsked
          ? `Nothing in the last 90 days, the longest window this page shows. Questions appear after ${shortName} asks in Ask.`
          : widerCount !== null && widerCount > 0
            ? `${shortName} asked ${plural(widerCount, "question", "questions")} in the last 90 days.`
            : `Questions appear here after ${shortName} asks in Ask.`
      }
    >
      {canWiden && onWiderWindow ? (
        <button type="button" onClick={onWiderWindow} className="btn-whisper px-3 py-1 text-xs">
          Show the last 90 days
        </button>
      ) : null}
    </EmptyState>
  );
}

function ReliesOn({
  shortName,
  days,
  sources,
  categoryPaths,
  onOpenSource
}: {
  shortName: string;
  days: number;
  sources: readonly SourceUsageSource[];
  categoryPaths: ReadonlyMap<string, string[]>;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const max = sources.reduce((top, source) => Math.max(top, source.citationCount), 0);
  const rows = showAll ? sources : sources.slice(0, RELIES_ON_ROWS);
  return (
    <section
      aria-labelledby="relies-on-title"
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card"
    >
      <div>
        <h3 id="relies-on-title" className="text-base font-semibold tracking-tight">
          Sources {shortName} relies on
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Answers that cited each source in the last {days} days.
        </p>
      </div>
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No answer cited a source in this window. Every question was refused.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {rows.map((source) => (
            <li key={source.documentId} className="min-w-0">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <SourceOpener
                    documentId={source.documentId}
                    title={source.title}
                    isLive={source.isLive}
                    onOpen={onOpenSource}
                    className="text-sm font-medium"
                  />
                  <CategoryPath
                    path={
                      source.title === null
                        ? null
                        : formatCategoryPaths(categoryPaths.get(source.documentId))
                    }
                  />
                </div>
                <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-muted-foreground">
                  {plural(source.citationCount, "answer", "answers")}
                </span>
              </div>
              <InlineBar width={barWidth(source.citationCount, max)} />
            </li>
          ))}
        </ol>
      )}
      {sources.length > RELIES_ON_ROWS ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="btn-whisper self-start px-3 py-1 text-xs"
        >
          {showAll ? `Show the top ${RELIES_ON_ROWS}` : `Show all ${sources.length} sources`}
        </button>
      ) : null}
    </section>
  );
}

function QuestionGroup({
  id,
  label,
  total,
  items,
  empty,
  note,
  onOpenSource
}: {
  id: string;
  label: string;
  /** The server's count for the window (may exceed the loaded items). */
  total: number;
  items: readonly SourceUsageQuestion[];
  empty: string;
  note: ReactNode;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, GROUP_ROWS);
  const titleId = `review-group-${id}`;
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={titleId} className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-muted-foreground">{label}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 tabular-nums text-muted-foreground">
            {total}
          </span>
        </h4>
        {total > 0 && visible.length < total ? (
          <span className="text-xs text-muted-foreground">
            Showing {visible.length} of {total}
          </span>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <>
          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          <div className="overflow-hidden rounded-lg border border-border">
            <QuestionList items={visible} onOpenSource={onOpenSource} hideSignals />
          </div>
          {items.length > GROUP_ROWS ? (
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll((value) => !value)}
              className="btn-whisper self-start px-3 py-1 text-xs"
            >
              {showAll ? `Show the first ${GROUP_ROWS}` : `Show all ${items.length}`}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function AllQuestions({
  total,
  shortName,
  data,
  error,
  onOpenSource
}: {
  total: number;
  shortName: string;
  data: SourceUsageQuestionsResponse | null;
  error: string | null;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const items = data?.items ?? [];
  const visible = showAll ? items : items.slice(0, ALL_ROWS);
  return (
    <section aria-labelledby="all-questions-title" className="flex flex-col gap-3">
      <div>
        <h3
          id="all-questions-title"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          All {shortName}'s questions ({total})
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Newest first, with the sources each answer cited.
        </p>
      </div>
      {error ? (
        <ErrorAlert message={error} />
      ) : !data ? (
        <QuestionsSkeleton />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
          <QuestionList items={visible} onOpenSource={onOpenSource} />
          {items.length > ALL_ROWS || data.truncated ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
              <span>
                Showing {visible.length} of {total}.
                {data.truncated ? ` Only the newest ${items.length} can be listed here.` : ""}
              </span>
              {items.length > ALL_ROWS ? (
                <button
                  type="button"
                  aria-expanded={showAll}
                  onClick={() => setShowAll((value) => !value)}
                  className="btn-whisper px-3 py-1 text-xs"
                >
                  {showAll ? `Show the newest ${ALL_ROWS}` : `Show all ${items.length}`}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function QuestionsSkeleton(): JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-4 rounded-lg border border-border p-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-3 w-1/4" />
        </div>
      ))}
      <span className="sr-only">Loading questions…</span>
    </div>
  );
}
