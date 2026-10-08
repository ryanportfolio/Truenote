import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  firstName,
  joinNames,
  neverCitedHref,
  personLabel,
  type AttentionCard
} from "@/lib/sourceUsage";

const ACTION_CLASS =
  "btn-whisper inline-flex w-full items-center justify-center px-4 py-2 text-sm font-medium text-primary";

function Big({ children }: { children: ReactNode }): JSX.Element {
  return (
    <span className="text-3xl font-semibold tabular-nums tracking-tight text-primary">
      {children}
    </span>
  );
}

/**
 * "Needs your attention": at most three cards, each one sentence with one
 * action. The page builds them from data (`attentionCards`), so a card only
 * exists while its fact is true; with none, the section is left out.
 */
export function AttentionCards({
  cards,
  onSelectPerson
}: {
  cards: readonly AttentionCard[];
  onSelectPerson: (userId: string) => void;
}): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="attention-title" className="flex flex-col gap-3">
      <h2 id="attention-title" className="text-xl font-semibold tracking-tight">
        Needs your attention
      </h2>
      <ul className="grid gap-4 md:grid-cols-3">
        {cards.map((card) => (
          <li
            key={card.kind}
            data-attention={card.kind}
            className="flex min-w-0 flex-col justify-between gap-4 rounded-lg border border-border bg-card p-5 shadow-card"
          >
            <CardBody card={card} onSelectPerson={onSelectPerson} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardBody({
  card,
  onSelectPerson
}: {
  card: AttentionCard;
  onSelectPerson: (userId: string) => void;
}): JSX.Element {
  switch (card.kind) {
    case "neverUsed":
      return (
        <>
          <p className="text-base leading-snug">
            <Big>{card.count}</Big> {card.count === 1 ? "source was" : "sources were"} never used
            in an answer.
          </p>
          <Link href={neverCitedHref(card.documentIds)} className={ACTION_CLASS}>
            Review sources
          </Link>
        </>
      );
    case "refused":
    case "negative": {
      const names = card.people.map((person) => personLabel(person));
      const lead = card.people[0];
      const each = card.people.length > 1 ? " each" : "";
      const what =
        card.kind === "refused"
          ? card.count === 1
            ? "question with no answer"
            : "questions with no answer"
          : card.count === 1
            ? "answer marked thumbs down"
            : "answers marked thumbs down";
      return (
        <>
          <p className="text-base leading-snug">
            {joinNames(names)} had{each} <Big>{card.count}</Big> {what}.
          </p>
          {lead ? (
            <button
              type="button"
              data-coach-person={lead.userId}
              onClick={() => onSelectPerson(lead.userId)}
              className={ACTION_CLASS}
            >
              Coach {firstName(personLabel(lead))}
            </button>
          ) : null}
        </>
      );
    }
    case "topSource":
      return (
        <>
          <p className="text-base leading-snug">
            <span className="font-medium">{card.source.title}</span> is used in{" "}
            <Big>{Math.round(card.share * 100)}%</Big> of answers.
          </p>
          <Link
            href={`/kb/${encodeURIComponent(card.source.documentId)}`}
            className={ACTION_CLASS}
          >
            Check it is up to date
          </Link>
        </>
      );
  }
}
