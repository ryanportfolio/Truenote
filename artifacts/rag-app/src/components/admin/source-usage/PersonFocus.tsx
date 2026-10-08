import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowLeft,
  BarChart3,
  BookOpen,
  Check,
  ClipboardCopy,
  MessageSquareText
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { RelativeTime } from "@/components/RelativeTime";
import { fetchSourceUsage, fetchSourceUsageQuestions } from "@/lib/api";
import {
  answeredRate,
  barWidth,
  compareWithTeam,
  firstName,
  formatAllCategoryPaths,
  formatCategoryPaths,
  formatPercent,
  plural,
  roleLabel,
  type TeamComparison
} from "@/lib/sourceUsage";
import { buildCoachingNotes, copyText, suggestionReasonText } from "@/lib/sourceUsageNotes";
import type {
  SourceUsageQuestion,
  SourceUsageQuestionsResponse,
  SourceUsageResponse,
  SourceUsageSource,
  SourceUsageSuggestion,
  SourceUsageUser
} from "@/types/api";
import { cn } from "@/lib/utils";
import { QuestionList } from "./QuestionList";
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
  /** Sources to suggest, from the server (up to 3, never one this person cited). */
  suggestions: readonly SourceUsageSuggestion[];
  team: TeamNumbers | null;
  categoryPaths: ReadonlyMap<string, string[]>;
  days: number;
  reloadKey: number;
  /** Time period dropdown and person picker, rendered in the header. */
  controls: ReactNode;
  onClear: () => void;
  onOpenSource: (documentId: string, title: string | null) => void;
  onWiderWindow: (() => void) | null;
}

/** One request covers the whole window for nearly everyone; the server caps at 200. */
const QUESTION_LIMIT = 200;
const RELIES_ON_ROWS = 8;
const TALK_ROWS = 2;
const ALL_ROWS = 10;

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/**
 * Header of the person view: back link, the person's name as the page title,
 * the page and view names, then the controls. Also used by the page while the
 * person's numbers load, so the header does not jump.
 */
export function PersonHeader({
  name,
  role,
  controls,
  action,
  onBack
}: {
  name: string;
  role: string | null;
  controls: ReactNode;
  action?: ReactNode;
  onBack: () => void;
}): JSX.Element {
  return (
    <header className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 self-start rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back to everyone
      </button>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              id="person-focus-title"
              tabIndex={-1}
              className="min-w-0 break-words rounded-sm font-display text-3xl font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              {name}
            </h1>
            {role ? <RoleBadge>{role}</RoleBadge> : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Source usage · Coaching guide</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {controls}
          {action}
        </div>
      </div>
    </header>
  );
}

/**
 * Coaching guide for one person: what is going well, what to talk about,
 * which sources to suggest, then the sources they rely on and every question
 * they asked. "Copy notes for 1:1" puts the same facts on the clipboard as
 * plain text.
 */
export function PersonFocus({
  userId,
  identity,
  name,
  row,
  totals,
  sources,
  suggestions,
  team,
  categoryPaths,
  days,
  reloadKey,
  controls,
  onClear,
  onOpenSource,
  onWiderWindow
}: PersonFocusProps): JSX.Element {
  const [data, setData] = useState<SourceUsageQuestionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasQuestions = totals.questions > 0;
  const shortName = firstName(name);
  const role = identity ? roleLabel(identity.role) : null;

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

  // A refused question is listed once, under refused, even when it also got a
  // thumbs down; the thumbs-down group holds answered questions only.
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    return {
      refused: items.filter((item) => item.refused),
      negative: items.filter((item) => item.feedback === -1 && !item.refused)
    };
  }, [data]);

  const negativeCount = row?.negativeCount ?? 0;
  const refusedWithNegative = groups.refused.filter((item) => item.feedback === -1).length;
  const negativeOnlyTotal = Math.max(0, negativeCount - refusedWithNegative);
  const comparison = compareWithTeam(
    {
      questions: totals.questions,
      answered: totals.answered,
      refused: totals.refused,
      negative: negativeCount
    },
    team
      ? {
          questions: team.totals.questions,
          answered: team.totals.answered,
          refused: team.totals.refused,
          negative: team.users.reduce((sum, user) => sum + user.negativeCount, 0)
        }
      : null
  );
  const teamAverage =
    team && team.totals.activeUsers > 0
      ? Math.round(team.totals.questions / team.totals.activeUsers)
      : null;
  const pathOf = (documentId: string): string | null =>
    formatCategoryPaths(categoryPaths.get(documentId));
  // The copied notes have room for every folder path.
  const allPathsOf = (documentId: string): string | null =>
    formatAllCategoryPaths(categoryPaths.get(documentId));
  const topSource = sources.find((source) => source.title !== null) ?? null;

  const notes = (): string =>
    buildCoachingNotes({
      name,
      role,
      days,
      questions: totals.questions,
      answered: totals.answered,
      negativeCount,
      comparison,
      topSource: topSource
        ? { source: topSource, path: allPathsOf(topSource.documentId) }
        : null,
      refused: groups.refused,
      negative: groups.negative,
      truncated: data?.truncated ?? false,
      suggestions,
      suggestionPaths: new Map(
        suggestions.map((item) => [item.documentId, allPathsOf(item.documentId)])
      )
    });

  return (
    <section aria-labelledby="person-focus-title" className="flex flex-col gap-6">
      <PersonHeader
        name={name}
        role={role}
        controls={controls}
        onBack={onClear}
        action={hasQuestions ? <CopyNotesButton ready={data !== null} build={notes} /> : null}
      />

      {!hasQuestions ? (
        <>
          <NoQuestions
            userId={userId}
            name={name}
            shortName={shortName}
            days={days}
            reloadKey={reloadKey}
            onWiderWindow={onWiderWindow}
          />
          {suggestions.length > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <SuggestSources name={name} suggestions={suggestions} pathOf={pathOf} />
            </div>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-base" data-person-summary="">
            {plural(totals.questions, "question", "questions")} in the last {days} days.
            {row?.lastAskedAt ? (
              <span className="text-muted-foreground">
                {" Last asked "}
                <RelativeTime iso={row.lastAskedAt} />.
              </span>
            ) : null}
          </p>

          {/*
            Reads top to bottom: the summary band across the full width, then
            Talk about beside Suggest these sources, then the relied-on list
            across the full width (beside Talk about when there is nothing to
            suggest). The DOM keeps the reading order.
          */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <GoingWell
              totals={totals}
              negative={negativeCount}
              comparison={comparison}
              teamAverage={teamAverage}
              topSource={topSource}
              topPath={topSource ? pathOf(topSource.documentId) : null}
              onOpenSource={onOpenSource}
            />
            <TalkAbout
              refusedTotal={totals.refused}
              negativeTotal={negativeOnlyTotal}
              refused={groups.refused}
              negative={groups.negative}
              loading={!data && !error}
              error={error}
              onOpenSource={onOpenSource}
            />
            {suggestions.length > 0 ? (
              <SuggestSources name={name} suggestions={suggestions} pathOf={pathOf} />
            ) : null}
            <ReliesOn
              fullWidth={suggestions.length > 0}
              shortName={shortName}
              days={days}
              sources={sources}
              categoryPaths={categoryPaths}
              onOpenSource={onOpenSource}
            />
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
 * Primary action of the coaching guide. The result is announced in a polite
 * live region ("Copied") and shown next to the button for a few seconds.
 */
function CopyNotesButton({
  ready,
  build
}: {
  ready: boolean;
  build: () => string;
}): JSX.Element {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  async function copy(): Promise<void> {
    const ok = await copyText(build());
    setStatus(ok ? "copied" : "failed");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setStatus("idle"), ok ? 4000 : 8000);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void copy()}
        disabled={!ready}
        className="btn-primary inline-flex items-center gap-2 px-5 py-2 text-base disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ClipboardCopy className="h-4 w-4" aria-hidden />
        Copy notes for 1:1
      </button>
      {/* A toast at the bottom of the screen, so the result never shifts the header. */}
      <span
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 whitespace-nowrap text-sm"
        data-copy-status={status}
      >
        {status === "copied" ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 font-medium text-success shadow-panel motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-240 motion-safe:ease-out-quart">
            <Check className="h-4 w-4" aria-hidden />
            Copied
          </span>
        ) : status === "failed" ? (
          <span className="inline-flex rounded-full border border-destructive/30 bg-card px-4 py-2 font-medium text-destructive shadow-panel">
            Your browser blocked copying. Try again.
          </span>
        ) : null}
      </span>
    </>
  );
}

function CardTitle({
  id,
  icon,
  children
}: {
  id: string;
  icon: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <h2 id={id} className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      {icon}
      {children}
    </h2>
  );
}

const CARD_CLASS =
  "flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-card";

/**
 * First card of the guide. Titled "Going well" only when the person is level
 * with the team or better (compareWithTeam); otherwise "At a glance", with
 * each comparison stated as plain numbers.
 */
function GoingWell({
  totals,
  negative,
  comparison,
  teamAverage,
  topSource,
  topPath,
  onOpenSource
}: {
  totals: SourceUsageResponse["totals"];
  negative: number;
  comparison: TeamComparison;
  teamAverage: number | null;
  topSource: SourceUsageSource | null;
  topPath: string | null;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const rate = formatPercent(answeredRate(totals.answered, totals.questions));
  const { goingWell, teamAnswered, refused, teamRefused, teamNegative } = comparison;
  return (
    <section
      aria-labelledby="going-well-title"
      className={`${CARD_CLASS} lg:col-span-2`}
      data-coaching-card={goingWell ? "going-well" : "at-a-glance"}
    >
      <CardTitle
        id="going-well-title"
        icon={
          goingWell ? (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-success/15 text-success">
              <Check className="h-4 w-4" aria-hidden />
            </span>
          ) : (
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <BarChart3 className="h-4 w-4" aria-hidden />
            </span>
          )
        }
      >
        {goingWell ? "Going well" : "At a glance"}
      </CardTitle>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
      <div className="min-w-0 flex-1">
        <p className="text-4xl font-semibold tabular-nums tracking-tight">{rate}</p>
        <p className="mt-1 text-sm">
          Answered {rate} of questions
          {teamAnswered !== null ? `; the team answered ${teamAnswered}%.` : "."}
        </p>
        {comparison.refusedAbove && !comparison.answeredBelow && teamRefused !== null ? (
          <p className="mt-1 text-sm">
            {refused}% of questions got no answer; for the team, {teamRefused}%.
          </p>
        ) : null}
        {comparison.negativeAbove && teamNegative !== null ? (
          <p className="mt-1 text-sm">
            Thumbs down on {negative} of {totals.questions} questions ({comparison.negative}%); for
            the team, {teamNegative}%.
          </p>
        ) : null}
        <p className="mt-1 text-sm text-muted-foreground">
          {totals.answered} of {totals.questions} got a cited answer.
          {teamAverage !== null
            ? ` Team average: ${plural(teamAverage, "question", "questions")} per person.`
            : ""}
        </p>
      </div>
      <div className="border-t border-border pt-4 lg:w-80 lg:shrink-0 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Most-used source
        </h3>
        {topSource ? (
          <div className="mt-1.5">
            <SourceOpener
              documentId={topSource.documentId}
              title={topSource.title}
              isLive={topSource.isLive}
              onOpen={onOpenSource}
              className="text-base font-medium"
            />
            <CategoryPath path={topPath} />
            <p className="mt-1 text-sm text-muted-foreground">
              {plural(topSource.citationCount, "answer", "answers")}
            </p>
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-muted-foreground">
            No answer used a source in this period.
          </p>
        )}
      </div>
      </div>
    </section>
  );
}

function TalkAbout({
  refusedTotal,
  negativeTotal,
  refused,
  negative,
  loading,
  error,
  onOpenSource
}: {
  /** Server counts for the window; the lists may stop at the question limit. */
  refusedTotal: number;
  negativeTotal: number;
  refused: readonly SourceUsageQuestion[];
  negative: readonly SourceUsageQuestion[];
  loading: boolean;
  error: string | null;
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const nothing = refusedTotal === 0 && negativeTotal === 0;
  return (
    <section
      aria-labelledby="talk-about-title"
      className={CARD_CLASS}
      data-coaching-card="talk-about"
    >
      <CardTitle
        id="talk-about-title"
        icon={
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-warning/25 text-warning-foreground">
            <AlertCircle className="h-4 w-4" aria-hidden />
          </span>
        }
      >
        Talk about
      </CardTitle>
      {nothing ? (
        <p className="text-sm text-muted-foreground">
          Nothing to talk about in this period: every question got an answer and none was marked
          thumbs down.
        </p>
      ) : error ? (
        <ErrorAlert message={error} />
      ) : loading ? (
        <div role="status" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-4 w-full" />
          ))}
          <span className="sr-only">Loading questions…</span>
        </div>
      ) : (
        <>
          {refusedTotal > 0 ? (
            <TalkGroup
              id="refused"
              label={plural(refusedTotal, "refused question", "refused questions")}
              items={refused}
              onOpenSource={onOpenSource}
            />
          ) : null}
          {negativeTotal > 0 ? (
            <TalkGroup
              id="negative"
              label={plural(negativeTotal, "thumbs-down question", "thumbs-down questions")}
              items={negative}
              onOpenSource={onOpenSource}
            />
          ) : null}
        </>
      )}
      <div className="mt-auto border-t border-border pt-3">
        <a
          href="#all-questions-title"
          onClick={(event) => {
            event.preventDefault();
            const heading = document.getElementById("all-questions-title");
            heading?.scrollIntoView({ block: "start" });
            heading?.focus({ preventScroll: true });
          }}
          className="rounded-sm text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Open questions
        </a>
      </div>
    </section>
  );
}

function TalkGroup({
  id,
  label,
  items,
  onOpenSource
}: {
  id: string;
  label: string;
  items: readonly SourceUsageQuestion[];
  onOpenSource: (documentId: string, title: string | null) => void;
}): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, TALK_ROWS);
  const titleId = `talk-group-${id}`;
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-2" data-talk-group={id}>
      <h3 id={titleId} className="self-start">
        <span className="inline-block rounded-full bg-warning/25 px-2.5 py-0.5 text-xs font-medium text-warning-foreground">
          {label}
        </span>
      </h3>
      <ul className="flex flex-col gap-3">
        {visible.map((item) => (
          <li key={item.queryLogId} className="min-w-0">
            <q className="block break-words text-sm">{item.question}</q>
            {id === "refused" && item.feedback === -1 ? (
              <span className="mt-1 inline-block rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                Thumbs down too
              </span>
            ) : null}
            {item.sources.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground">No cited answer.</p>
            ) : (
              <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-sm">
                {item.sources.map((source) => (
                  <SourceOpener
                    key={source.documentId}
                    documentId={source.documentId}
                    title={source.title}
                    onOpen={onOpenSource}
                    className={LINK_CLASS}
                  />
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
      {items.length > TALK_ROWS ? (
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((value) => !value)}
          className="btn-whisper self-start px-3 py-1 text-xs"
        >
          {showAll ? `Show the first ${TALK_ROWS}` : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

function SuggestSources({
  name,
  suggestions,
  pathOf
}: {
  name: string;
  suggestions: readonly SourceUsageSuggestion[];
  pathOf: (documentId: string) => string | null;
}): JSX.Element {
  const groups = (["related", "team_top"] as const)
    .map((reason) => ({ reason, items: suggestions.filter((item) => item.reason === reason) }))
    .filter((group) => group.items.length > 0);
  return (
    <section
      aria-labelledby="suggest-title"
      className={CARD_CLASS}
      data-coaching-card="suggest"
    >
      <CardTitle
        id="suggest-title"
        icon={<BookOpen className="h-6 w-6 text-muted-foreground" aria-hidden />}
      >
        Suggest these sources
      </CardTitle>
      {groups.map((group) => (
        <div key={group.reason} className="flex flex-col gap-2" data-suggest-reason={group.reason}>
          <p className="text-sm text-muted-foreground">{suggestionReasonText(group.reason, name)}</p>
          <ul className="divide-y divide-border">
            {group.items.map((item) => (
              <li key={item.documentId} className="flex min-w-0 items-start gap-3 py-2.5">
                <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <Link
                    href={`/kb/${encodeURIComponent(item.documentId)}`}
                    className="rounded-sm text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {item.title}
                  </Link>
                  <CategoryPath path={pathOf(item.documentId)} />
                  <span className="block text-xs text-muted-foreground">
                    Teammates used it {plural(item.teamCitations, "time", "times")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <Link
        href="/kb"
        className="btn-whisper mt-auto inline-flex justify-center px-4 py-2 text-sm font-medium"
      >
        Browse sources
      </Link>
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
          ? `Nothing in the last 90 days, the longest period this page shows. Questions appear after ${shortName} asks in Ask.`
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
  fullWidth,
  shortName,
  days,
  sources,
  categoryPaths,
  onOpenSource
}: {
  /** Span both columns from lg (when Suggest these sources takes the second). */
  fullWidth: boolean;
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
      className={cn(CARD_CLASS, fullWidth && "lg:col-span-2")}
      data-relies-on=""
    >
      <div>
        <h2 id="relies-on-title" className="text-lg font-semibold tracking-tight">
          Sources {shortName} relies on
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Answers in the last {days} days.
        </p>
      </div>
      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No answer used a source in this period. Every question went without an answer.
        </p>
      ) : (
        <ol className={cn("grid gap-x-8 gap-y-3 md:grid-cols-2", !fullWidth && "lg:grid-cols-1")}>
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
        <h2
          id="all-questions-title"
          tabIndex={-1}
          className="scroll-mt-6 rounded-sm text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          All {shortName}'s questions ({total})
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Newest first, with the sources each answer used.
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
