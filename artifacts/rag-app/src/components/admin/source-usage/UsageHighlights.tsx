import { Fragment } from "react";
import { personLabel, percentOf, usageHighlights, type PersonStandout } from "@/lib/sourceUsage";
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
 * linking to the view that explains it. A tie names everyone in it; a count
 * of 1 or a wide tie is not a standout and gets no sentence.
 */
export function UsageHighlights({
  sources,
  users,
  answered,
  onOpenSource,
  onSelectPerson
}: UsageHighlightsProps): JSX.Element | null {
  const { topSource, mostRefused, mostNegative } = usageHighlights(sources, users, answered);
  const single = (standout: PersonStandout | null): SourceUsageUser | null =>
    standout && standout.people.length === 1 ? standout.people[0] ?? null : null;
  const refusedPerson = single(mostRefused);
  const negativePerson = single(mostNegative);
  const samePerson =
    refusedPerson !== null && negativePerson !== null && refusedPerson.userId === negativePerson.userId;

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

  /** "A", "A and B", "A, B and C" with each name a button. */
  const names = (people: readonly SourceUsageUser[]): JSX.Element => (
    <>
      {people.map((person, i) => (
        <Fragment key={person.userId}>
          {i === 0 ? "" : i === people.length - 1 ? " and " : ", "}
          {personButton(person)}
        </Fragment>
      ))}
    </>
  );

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
    const share = refusedPerson ? percentOf(mostRefused.count, refusedPerson.questionCount) : null;
    lines.push(
      <li key="refused">
        {names(mostRefused.people)} had the most refused questions:{" "}
        {refusedPerson
          ? `${mostRefused.count} of ${refusedPerson.questionCount}${share ? ` (${share})` : ""}`
          : `${mostRefused.count} each`}
        {samePerson && mostNegative
          ? `, and the most thumbs-down answers: ${mostNegative.count}.`
          : "."}
      </li>
    );
  }
  if (mostNegative && !samePerson) {
    lines.push(
      <li key="negative">
        {names(mostNegative.people)} got the most thumbs-down answers:{" "}
        {negativePerson
          ? `${mostNegative.count} of ${negativePerson.questionCount} questions.`
          : `${mostNegative.count} each.`}
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
