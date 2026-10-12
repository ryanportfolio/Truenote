import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { FilePlus2, FileText, RefreshCw } from "lucide-react";
import { fetchGapAnalysis } from "@/lib/api";
import { PortalArt } from "@/components/DemoPortal";
import { RelativeTime } from "@/components/RelativeTime";
import type { GapAnalysisResponse, GapTheme } from "@/types/api";

/** A cached answer comes back fast; show the loader only for a real run. */
const LOADER_DELAY_MS = 250;

interface GapAnalysisProps {
  windowDays: number;
  /** Changes when the selected program changes, to refetch. */
  reloadKey: number;
  /** Manager and above can open the upload form from a "new source" theme. */
  canAddSources: boolean;
}

type Ready = Extract<GapAnalysisResponse, { status: "ready" | "empty" }>;

/**
 * The Gaps page's roll-up: refused questions grouped into themes, each with
 * the reason it was refused and the source to add or update. Runs on page
 * load (the server reuses the last result until a new refusal lands) and on
 * "Run again". While a run is in flight, the archive portal plays.
 */
export function GapAnalysis({
  windowDays,
  reloadKey,
  canAddSources
}: GapAnalysisProps): JSX.Element {
  const [data, setData] = useState<Ready | null>(null);
  const [running, setRunning] = useState(true);
  const [showLoader, setShowLoader] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noProgram, setNoProgram] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const run = useCallback(
    async (refresh: boolean): Promise<void> => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      setRunning(true);
      setError(null);
      const timer = window.setTimeout(() => setShowLoader(true), refresh ? 0 : LOADER_DELAY_MS);
      try {
        const result = await fetchGapAnalysis(windowDays, refresh, abort.signal);
        if (abort.signal.aborted) return;
        if (result.status === "no_program") {
          setNoProgram(true);
          setData(null);
        } else {
          setNoProgram(false);
          setData(result);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The gap analysis failed. Try again.");
      } finally {
        window.clearTimeout(timer);
        if (!abort.signal.aborted) {
          setRunning(false);
          setShowLoader(false);
        }
      }
    },
    [windowDays]
  );

  useEffect(() => {
    void run(false);
    return () => controller.current?.abort();
  }, [run, reloadKey]);

  if (noProgram) return <></>;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="gap-analysis-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="gap-analysis-heading"
          className="text-sm font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Gap analysis
        </h2>
        <button
          type="button"
          onClick={() => void run(true)}
          disabled={running}
          className="btn-whisper inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          Run again
        </button>
      </div>

      {running && showLoader ? (
        <GapLoader windowDays={windowDays} />
      ) : running ? (
        <div className="min-h-[13rem]" aria-busy="true" />
      ) : error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      ) : data?.status === "empty" ? (
        <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
          No refused questions in the last {data.windowDays} days, so there is nothing to analyze.
        </p>
      ) : data ? (
        <GapResults data={data} canAddSources={canAddSources} />
      ) : null}
    </section>
  );
}

function GapLoader({ windowDays }: { windowDays: number }): JSX.Element {
  return (
    <div
      role="status"
      className="flex min-h-[13rem] flex-col items-center gap-2 overflow-hidden rounded-lg border border-border bg-card px-5 py-4 shadow-card sm:flex-row sm:gap-6"
    >
      <div className="gap-portal" aria-hidden>
        <PortalArt role="manager" burst={1} />
      </div>
      <div className="max-w-md text-center sm:text-left">
        <p className="font-display text-xl font-semibold tracking-tight">
          Reading the refused questions
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          Every question refused in the last {windowDays} days is checked against your
          sources, then grouped into themes. This can take up to a minute.
        </p>
      </div>
    </div>
  );
}

function GapResults({
  data,
  canAddSources
}: {
  data: Ready;
  canAddSources: boolean;
}): JSX.Element {
  const checked = data.analyzedQuestions + data.heldOutQuestions;
  const partial = checked < data.distinctQuestions;
  const heldOut =
    data.heldOutQuestions === 1
      ? " 1 question was left out because it reads as instructions to an AI, such as a security test."
      : data.heldOutQuestions > 1
        ? ` ${data.heldOutQuestions} questions were left out because they read as instructions to an AI, such as security tests.`
        : "";
  if (data.analyzedQuestions === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        Every refused question in the last {data.windowDays} days reads as instructions to an AI,
        such as a security test, so there is nothing to group.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {data.refusedAsks} refused {data.refusedAsks === 1 ? "ask" : "asks"} across{" "}
        {data.distinctQuestions} {data.distinctQuestions === 1 ? "question" : "questions"} in the
        last {data.windowDays} days
        {partial ? `; the ${checked} most-asked were analyzed` : ""}. Updated{" "}
        <RelativeTime iso={data.analyzedAt} />
        {data.model ? ` by ${data.model.label} (${data.model.providerLabel})` : ""}.
      </p>

      <ol className="flex flex-col gap-3">
        {data.themes.map((theme) => (
          <ThemeCard key={theme.title} theme={theme} canAddSources={canAddSources} />
        ))}
      </ol>

      <p className="text-xs text-muted-foreground">
        AI writes the theme names and summaries. Counts come from the query log, and each
        source is the closest match a fresh search found for the theme's questions.
        {data.ungroupedQuestions > 0
          ? ` ${data.ungroupedQuestions} ${data.ungroupedQuestions === 1 ? "question fits" : "questions fit"} no theme; Top gaps below lists every question.`
          : ""}
        {heldOut}
      </p>
    </div>
  );
}

const KIND_LABEL: Record<GapTheme["kind"], string> = {
  new: "Add a source",
  update: "Update a source",
  covered: "Now covered"
};

// Literal class names, so Tailwind keeps the rules in index.css.
const KIND_CLASS: Record<GapTheme["kind"], string> = {
  new: "gap-theme-kind gap-theme-kind-new",
  update: "gap-theme-kind gap-theme-kind-update",
  covered: "gap-theme-kind gap-theme-kind-covered"
};

function ThemeCard({
  theme,
  canAddSources
}: {
  theme: GapTheme;
  canAddSources: boolean;
}): JSX.Element {
  return (
    <li className="gap-theme rounded-lg border border-border bg-card px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <span className={KIND_CLASS[theme.kind]}>
            {KIND_LABEL[theme.kind]}
          </span>
          <h3 className="mt-1 text-base font-semibold leading-snug">{theme.title}</h3>
        </div>
        <p className="shrink-0 text-sm tabular-nums text-muted-foreground">
          <span className="text-lg font-semibold text-foreground">{theme.refusedCount}</span>{" "}
          refused
          {theme.flaggedCount > 0 ? (
            <span className="ml-2 rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-foreground">
              {theme.flaggedCount} flagged
            </span>
          ) : null}
        </p>
      </div>

      {theme.summary ? <p className="mt-1 text-sm">{theme.summary}</p> : null}

      <p className="mt-2 text-sm text-muted-foreground">
        {theme.kind === "new"
          ? "Why refused: nothing in the knowledge base comes close to these questions."
          : theme.kind === "update"
            ? "Why refused: a source comes close but does not answer these clearly enough."
            : "These were refused when asked, but a search today finds an answer."}
      </p>

      <ul className="mt-2 flex flex-col gap-1 border-l-2 border-border pl-3 text-sm">
        {theme.sampleQuestions.map((question) => (
          <li key={question} className="text-muted-foreground">
            “{question}”
          </li>
        ))}
        {theme.questionCount > theme.sampleQuestions.length ? (
          <li className="text-xs text-muted-foreground">
            and {theme.questionCount - theme.sampleQuestions.length} more
          </li>
        ) : null}
      </ul>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {theme.source ? (
          <Link
            href={`/kb/${encodeURIComponent(theme.source.documentId)}`}
            className="btn-whisper inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            Open {theme.source.title}
          </Link>
        ) : null}
        {theme.kind === "new" && theme.suggestedTitle ? (
          canAddSources ? (
            <Link
              href={`/admin/documents?title=${encodeURIComponent(theme.suggestedTitle.slice(0, 120))}`}
              className="btn-whisper inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
              Add “{theme.suggestedTitle}”
            </Link>
          ) : (
            <span className="text-xs text-muted-foreground">
              Suggested source: “{theme.suggestedTitle}”
            </span>
          )
        ) : null}
      </div>
    </li>
  );
}
