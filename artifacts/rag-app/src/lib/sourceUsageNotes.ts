import type {
  SourceUsageQuestion,
  SourceUsageSource,
  SourceUsageSuggestion
} from "@/types/api";
import { firstName, formatPercent, plural } from "./sourceUsage";

/**
 * Plain-text notes a manager pastes into a 1:1 doc or chat: the period, the
 * person's numbers against the team, every refused and thumbs-down question
 * with what the answer cited, and the suggested sources. Plain text only, so
 * it pastes cleanly anywhere.
 */

export interface CoachingNotesInput {
  name: string;
  role: string | null;
  days: number;
  questions: number;
  answered: number;
  /** Team answered rate 0..1, or null while unknown. */
  teamAnsweredRate: number | null;
  topSource: { source: SourceUsageSource; path: string | null } | null;
  refused: readonly SourceUsageQuestion[];
  negative: readonly SourceUsageQuestion[];
  /** True when the question list stopped at the server's limit. */
  truncated: boolean;
  suggestions: readonly SourceUsageSuggestion[];
  suggestionPaths: ReadonlyMap<string, string | null>;
}

export function suggestionReasonText(reason: SourceUsageSuggestion["reason"], name: string): string {
  return reason === "related"
    ? "Teammates use these for similar topics."
    : `Your team uses these often; ${firstName(name)} has not used them yet.`;
}

function quoted(question: SourceUsageQuestion): string {
  return `"${question.question.replace(/\s+/g, " ").trim()}"`;
}

function citedLine(question: SourceUsageQuestion): string {
  if (question.sources.length === 0) return "No cited answer.";
  const titles = question.sources.map((source) => source.title ?? "Restricted source");
  return `Answer used: ${titles.join(", ")}.`;
}

export function buildCoachingNotes(input: CoachingNotesInput): string {
  const lines: string[] = [];
  const short = firstName(input.name);
  lines.push(`1:1 notes for ${input.name}${input.role ? ` (${input.role})` : ""}`);
  lines.push(`Period: last ${input.days} days`);
  lines.push("");
  lines.push(`Questions asked: ${input.questions}`);
  const rate = input.questions > 0 ? input.answered / input.questions : null;
  lines.push(
    `Answered with a source: ${formatPercent(rate)} (${input.answered} of ${input.questions})` +
      (input.teamAnsweredRate !== null ? `. Team: ${formatPercent(input.teamAnsweredRate)}.` : ".")
  );
  if (input.topSource && input.topSource.source.title !== null) {
    const { source, path } = input.topSource;
    lines.push(
      `Most used source: ${source.title}${path ? ` (${path})` : ""}, ${plural(source.citationCount, "answer", "answers")}`
    );
  }

  const section = (title: string, items: readonly SourceUsageQuestion[]): void => {
    lines.push("");
    lines.push(`${title} (${items.length})`);
    if (items.length === 0) {
      lines.push("- None in this period.");
      return;
    }
    for (const item of items) lines.push(`- ${quoted(item)} ${citedLine(item)}`);
  };
  section("Questions with no answer", input.refused);
  section("Answers marked thumbs down", input.negative);
  if (input.truncated) {
    lines.push("");
    lines.push(`Only ${short}'s newest questions were checked for this list.`);
  }

  if (input.suggestions.length > 0) {
    lines.push("");
    lines.push("Sources to suggest");
    for (const reason of ["related", "team_top"] as const) {
      const items = input.suggestions.filter((item) => item.reason === reason);
      if (items.length === 0) continue;
      lines.push(suggestionReasonText(reason, input.name));
      for (const item of items) {
        const path = input.suggestionPaths.get(item.documentId);
        lines.push(`- ${item.title}${path ? ` (${path})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Copies text. Uses the async Clipboard API, then falls back to selecting a
 * hidden textarea and the legacy copy command (older browsers, or a page not
 * served over https). Resolves true when one of them worked.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no focus: try the fallback below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.tabIndex = -1;
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  area.style.opacity = "0";
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  return ok;
}
