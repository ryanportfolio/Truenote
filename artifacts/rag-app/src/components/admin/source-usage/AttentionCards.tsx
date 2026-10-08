import { Fragment, type ReactNode } from "react";
import { Link } from "wouter";
import {
  firstName,
  neverCitedHref,
  personLabel,
  type AttentionCard
} from "@/lib/sourceUsage";

type AttentionCardPerson = Extract<AttentionCard, { kind: "refused" }>["people"][number];

const NAME_LINK_CLASS =
  "rounded-sm font-medium text-primary underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

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
  days,
  onSelectPerson
}: {
  cards: readonly AttentionCard[];
  /** The window the facts come from, named in the never-used sentence. */
  days: number;
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
            <CardBody card={card} days={days} onSelectPerson={onSelectPerson} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardBody({
  card,
  days,
  onSelectPerson
}: {
  card: AttentionCard;
  days: number;
  onSelectPerson: (userId: string) => void;
}): JSX.Element {
  switch (card.kind) {
    case "neverUsed":
      return (
        <>
          <p className="text-base leading-snug">
            <Big>{card.count}</Big> {card.count === 1 ? "source was" : "sources were"} not used in
            any answer in the last {days} days.
          </p>
          <Link href={neverCitedHref(card.documentIds, days)} className={ACTION_CLASS}>
            Review sources
          </Link>
        </>
      );
    case "refused":
    case "negative": {
      const lead = card.people[0];
      const tie = card.people.length > 1;
      const what =
        card.kind === "refused"
          ? card.count === 1
            ? "question with no answer"
            : "questions with no answer"
          : card.count === 1
            ? "question marked thumbs down"
            : "questions marked thumbs down";
      return (
        <>
          <p className="text-base leading-snug">
            <Names people={card.people} linked={tie} onSelectPerson={onSelectPerson} />
            {tie ? " each had " : " had "}
            <Big>{card.count}</Big> {what}.
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

/**
 * "Jordan Reyes", "Jordan Reyes and Marcus Webb", "A, B and C". In a tie each
 * name opens that person's coaching guide, so the card keeps one button and
 * every tied person is still one click away.
 */
function Names({
  people,
  linked,
  onSelectPerson
}: {
  people: AttentionCardPerson[];
  linked: boolean;
  onSelectPerson: (userId: string) => void;
}): JSX.Element {
  return (
    <>
      {people.map((person, index) => {
        const label = personLabel(person);
        const separator =
          index === 0 ? "" : index === people.length - 1 ? " and " : ", ";
        return (
          <Fragment key={person.userId}>
            {separator}
            {linked ? (
              <button
                type="button"
                data-coach-name={person.userId}
                title={`Open ${label}'s coaching guide`}
                onClick={() => onSelectPerson(person.userId)}
                className={NAME_LINK_CLASS}
              >
                {label}
              </button>
            ) : (
              label
            )}
          </Fragment>
        );
      })}
    </>
  );
}
