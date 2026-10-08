import { personLabel, percentOf, usageHighlights } from "@/lib/sourceUsage";
import type { SourceUsageSource, SourceUsageUser } from "@/types/api";
import { SourceOpener } from "./shared";

interface UsageHighlightsProps {
  sources: readonly SourceUsageSource[];
  users: readonly SourceUsageUser[];
  answered: number;
  onOpenSource: (documentId: string, title: string | null) => void;
  onSelectPerson: (userId: string) => void;
}

const LINK_CLASS =
  "rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

/**
 * One to three sentences built from the window's numbers: the source answers
 * lean on most, and who had the most refusals and thumbs-down answers, each
 * linking to the view that explains it.
 */
export function UsageHighlights({
  sources,
  users,
  answered,
  onOpenSource,
  onSelectPerson
}: UsageHighlightsProps): JSX.Element | null {
  const { topSource, mostRefused, mostNegative } = usageHighlights(sources, users, answered);
  const samePerson =
    mostRefused !== null && mostNegative !== null && mostRefused.userId === mostNegative.userId;

  const personButton = (person: SourceUsageUser): JSX.Element => {
    const name = personLabel(person);
    return (
      <button
        type="button"
        aria-label={`${name}, show their questions`}
        onClick={() => onSelectPerson(person.userId)}
        className={LINK_CLASS}
      >
        {name}
      </button>
    );
  };

  const lines: JSX.Element[] = [];
  if (topSource) {
    const { source, share, next } = topSource;
    lines.push(
      <li key="top">
        <SourceOpener
          documentId={source.documentId}
          title={source.title}
          isLive={source.isLive}
          onOpen={onOpenSource}
          className="font-medium text-primary"
        />{" "}
        was cited in {source.citationCount} of {answered} answered questions (
        {Math.round(share * 100)}%)
        {next ? `; the next source was cited in ${next.citationCount}.` : "."}
      </li>
    );
  }
  if (mostRefused) {
    lines.push(
      <li key="refused">
        {personButton(mostRefused)} had the most refused questions: {mostRefused.refusedCount} of{" "}
        {mostRefused.questionCount}
        {percentOf(mostRefused.refusedCount, mostRefused.questionCount)
          ? ` (${percentOf(mostRefused.refusedCount, mostRefused.questionCount)})`
          : ""}
        {samePerson && mostNegative
          ? `, and the most thumbs-down answers: ${mostNegative.negativeCount}.`
          : "."}
      </li>
    );
  }
  if (mostNegative && !samePerson) {
    lines.push(
      <li key="negative">
        {personButton(mostNegative)} got the most thumbs-down answers: {mostNegative.negativeCount}{" "}
        of {mostNegative.questionCount} questions.
      </li>
    );
  }
  if (lines.length === 0) return null;

  return (
    <section aria-label="Highlights" className="rounded-lg border border-border bg-card px-5 py-4 shadow-card">
      <ul className="flex flex-col gap-1.5 text-sm leading-relaxed">{lines}</ul>
    </section>
  );
}
