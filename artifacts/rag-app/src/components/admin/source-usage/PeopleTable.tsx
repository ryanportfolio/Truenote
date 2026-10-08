import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { RelativeTime } from "@/components/RelativeTime";
import {
  answeredRate,
  formatPercent,
  nextSort,
  personLabel,
  plural,
  roleLabel,
  sortUsers,
  type SortState,
  type UserSortKey
} from "@/lib/sourceUsage";
import type { SourceUsageUser } from "@/types/api";
import { SortHeader, SourceName } from "./shared";

const TEXT_KEYS: readonly UserSortKey[] = ["name"];

interface PeopleTableProps {
  users: readonly SourceUsageUser[];
  onSelectPerson: (userId: string) => void;
  /** Opens one of the person's top sources, filtered to that person. */
  onOpenPersonSource: (userId: string, documentId: string, title: string | null) => void;
}

/**
 * One row per person who asked in the window. Selecting a name applies the
 * person filter: the page becomes that person's coaching view.
 */
export function PeopleTable({
  users,
  onSelectPerson,
  onOpenPersonSource
}: PeopleTableProps): JSX.Element {
  const [sort, setSort] = useState<SortState<UserSortKey>>({
    key: "questionCount",
    direction: "desc"
  });
  const sorted = useMemo(() => sortUsers(users, sort), [users, sort]);
  const onSort = (key: UserSortKey): void => setSort((current) => nextSort(current, key, TEXT_KEYS));

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
      <table className="w-full text-sm">
        <caption className="sr-only">
          People who asked questions in this window. Select a name to see that person's questions.
        </caption>
        <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <SortHeader label="Person" sortKey="name" sort={sort} onSort={onSort} />
            <SortHeader
              label="Questions"
              sortKey="questionCount"
              sort={sort}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              label="Answered"
              sortKey="answeredRate"
              sort={sort}
              onSort={onSort}
              align="right"
              className="hidden sm:table-cell"
            />
            <SortHeader
              label="Refused"
              sortKey="refusedCount"
              sort={sort}
              onSort={onSort}
              align="right"
              className="hidden md:table-cell"
            />
            <SortHeader
              label="Thumbs down"
              sortKey="negativeCount"
              sort={sort}
              onSort={onSort}
              align="right"
              className="hidden md:table-cell"
            />
            <th scope="col" className="hidden px-3 py-2 font-medium lg:table-cell">
              Most-used sources
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((person) => {
            const name = personLabel(person);
            const rate = formatPercent(answeredRate(person.answeredCount, person.questionCount));
            return (
              <tr
                key={person.userId}
                className="border-t border-border align-top transition-colors duration-100 ease-out hover:bg-muted/40"
              >
                <td className="px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onSelectPerson(person.userId)}
                    className="group inline-flex items-center gap-1 rounded-sm text-left font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    {name}
                    <span className="sr-only">, show their questions</span>
                    <ChevronRight
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-100 ease-out group-hover:translate-x-0.5 motion-reduce:transition-none"
                      aria-hidden
                    />
                  </button>
                  <span className="block text-xs text-muted-foreground">
                    {roleLabel(person.role)}
                    {person.lastAskedAt ? (
                      <>
                        {" · last asked "}
                        <RelativeTime iso={person.lastAskedAt} />
                      </>
                    ) : null}
                  </span>
                  {/* Narrow screens fold the hidden columns into one line. */}
                  <span className="mt-1 block text-xs text-muted-foreground sm:hidden">
                    {rate} answered
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground md:hidden">
                    {plural(person.refusedCount, "refused", "refused")}
                    {person.negativeCount > 0 ? ` · ${person.negativeCount} thumbs down` : ""}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {person.questionCount}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground sm:table-cell">
                  {rate}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums text-muted-foreground md:table-cell">
                  {person.refusedCount}
                </td>
                <td className="hidden px-3 py-2 text-right tabular-nums md:table-cell">
                  {person.negativeCount > 0 ? (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                      {person.negativeCount}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="hidden max-w-xs px-3 py-2 lg:table-cell">
                  {person.topSources.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No cited answers</span>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {person.topSources.map((source) => (
                        <li key={source.documentId} className="flex items-baseline gap-2 text-xs">
                          <button
                            type="button"
                            aria-haspopup="dialog"
                            onClick={() =>
                              onOpenPersonSource(person.userId, source.documentId, source.title)
                            }
                            className="min-w-0 truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                            title={source.title ?? "Restricted source"}
                          >
                            <SourceName title={source.title} />
                            <span className="sr-only">, show {name}'s questions that cited it</span>
                          </button>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {source.count}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
