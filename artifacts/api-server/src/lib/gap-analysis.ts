import type { ApprovedModelRoute } from "./generation/model-routing.js";
import { scanTextForSensitiveContent } from "./security/content-scan.js";
import { protectProviderText } from "./security/provider-input-firewall.js";

/**
 * Gap analysis: the Gaps page's roll-up of refused questions into themes,
 * each with a reason and a source recommendation.
 *
 * The model only groups questions and names the groups. Everything a manager
 * could act on is checked or computed here, never taken from the model:
 *   - a theme holds only question ids the server sent, each at most once;
 *   - counts come from query_log, not from the model;
 *   - the reason comes from re-running retrieval on each question against the
 *     current knowledge base and comparing the best score with the refusal
 *     threshold;
 *   - an "update this source" recommendation names only a document that
 *     retrieval returned for the theme's own questions, within the asker's
 *     program and clearance. The model's own source title is shown only as a
 *     suggested title for a new source.
 */

/** Distinct refused questions sent to the model, most-asked first. */
export const MAX_GAP_GROUPS = 60;
export const MAX_THEMES = 10;
const MAX_TITLE_CHARS = 80;
const MAX_SUMMARY_CHARS = 240;
const MAX_SAMPLES = 3;

/**
 * A near miss at or above this share of the refusal threshold counts as "a
 * source is close": the source exists but does not answer clearly enough, so
 * updating it is the likelier fix. Below it, nothing in the knowledge base is
 * close and a new source is needed.
 */
export const NEAR_MISS_RATIO = 0.5;

export interface GapQuestionGroup {
  /** Stable id sent to the model, e.g. "q7". */
  id: string;
  question: string;
  count: number;
  flagged: number;
  lastAskedAt: string;
}

/** Best retrieval hit for one question against the current knowledge base. */
export interface GapNearMiss {
  documentId: string;
  title: string;
  score: number;
}

export interface GapProbe {
  /** Null when retrieval returned nothing at all. */
  best: GapNearMiss | null;
  threshold: number;
}

export type GapThemeKind = "update" | "new" | "covered";

export interface GapThemeSource {
  documentId: string;
  title: string;
}

export interface GapTheme {
  title: string;
  summary: string;
  kind: GapThemeKind;
  /** Refused asks in the theme (sum over its questions). */
  refusedCount: number;
  flaggedCount: number;
  /** Distinct questions in the theme. */
  questionCount: number;
  sampleQuestions: string[];
  /** The existing source to update (kind "update") or that now answers (kind "covered"). */
  source: GapThemeSource | null;
  /** The model's proposed title for a new source (kind "new" only). */
  suggestedTitle: string | null;
  lastAskedAt: string;
}

export interface ModelTheme {
  title: string;
  summary: string;
  questionIds: string[];
  suggestedSource: string | null;
}

export function buildGapAnalysisPrompt(
  groups: readonly GapQuestionGroup[],
  probes: ReadonlyMap<string, GapProbe>
): { system: string; user: string } {
  const system = [
    "You review questions that a customer-service knowledge assistant could not answer from its knowledge base.",
    "Group the questions into at most " + MAX_THEMES + " themes a manager can act on. A theme is a topic the knowledge base is missing or covers poorly.",
    "Each question line starts with its id (q1, q2, ...). Refer to questions by id only, never by their text. Put each id in at most one theme. Leave out ids that fit no theme.",
    "For each theme give: a short title (under 8 words), a one-sentence summary of what callers are asking and what the knowledge base lacks, the ids of its questions, and a short title for the source document that would answer it.",
    "Do not invent policies, fees, dates or numbers. Describe what is missing, not what the answer is.",
    'Reply with JSON only, no prose and no code fence: {"themes":[{"title":"...","summary":"...","questionIds":["q1","q2"],"suggestedSource":"..."}]}'
  ].join("\n");
  const lines = groups.map((group) => {
    const probe = probes.get(group.id);
    const near = probe?.best ? ` | closest source: "${probe.best.title}"` : " | closest source: none";
    return `${group.id} (asked ${group.count}x${near}): ${oneLine(group.question)}`;
  });
  return { system, user: `Refused questions:\n${lines.join("\n")}` };
}

/**
 * Parse the model's reply into themes. Tolerates a code fence or prose around
 * the JSON (structured output is not enforced on ZDR providers), a bare array
 * of themes, and the key spellings models drift to (questions, question_ids,
 * ids; name for title). Question references are kept raw; assembleGapThemes
 * resolves them to ids. Returns null when no themes array is present, so the
 * caller can try the next route.
 */
export function parseModelThemes(text: string): ModelTheme[] | null {
  const parsed = parseJsonLoosely(text);
  const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  const themes = Array.isArray(parsed)
    ? parsed
    : record
      ? (pick(record, ["themes", "Themes", "groups"]) ?? soleArray(record))
      : undefined;
  if (!Array.isArray(themes)) return null;
  const out: ModelTheme[] = [];
  for (const raw of themes) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const title = pick(item, ["title", "name", "theme"]);
    const summary = pick(item, ["summary", "description"]);
    const suggested = pick(item, ["suggestedSource", "suggested_source", "source"]);
    out.push({
      title: typeof title === "string" ? title : "",
      summary: typeof summary === "string" ? summary : "",
      questionIds: questionRefs(pick(item, ["questionIds", "question_ids", "questions", "ids"])),
      suggestedSource: typeof suggested === "string" ? suggested : null
    });
  }
  return out;
}

/** The whole reply, else its outermost {...}, else its outermost [...]. */
function parseJsonLoosely(text: string): unknown {
  const candidates = [text.trim()];
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function pick(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

/** The object's only array value, for a reply that renamed the themes key. */
function soleArray(record: Record<string, unknown>): unknown[] | undefined {
  const arrays = Object.values(record).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : undefined;
}

function questionRefs(value: unknown): string[] {
  const items: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return items
    .map((item) => (typeof item === "number" ? String(item) : item))
    .filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

/**
 * Resolve one question reference from the model to a group id: "q7", "Q07",
 * "q7: question text" or a bare 7 by number, else the question's exact text.
 */
function resolveQuestionRef(
  ref: string,
  byText: ReadonlyMap<string, string>
): string | null {
  const normalized = oneLine(ref).toLowerCase();
  const numbered = /^q0*(\d+)\b/.exec(normalized) ?? /^0*(\d+)$/.exec(normalized);
  if (numbered) return `q${numbered[1]}`;
  return byText.get(normalized.replace(/^["'`]+|["'`]+$/g, "")) ?? null;
}

/**
 * Turn model themes into checked themes: unknown references dropped, each id used
 * once (first theme wins), empty or untitled themes dropped, counts and
 * samples from the server's groups, kind and source from retrieval. Sorted by
 * refused asks, most first.
 */
export function assembleGapThemes(
  modelThemes: readonly ModelTheme[],
  groups: readonly GapQuestionGroup[],
  probes: ReadonlyMap<string, GapProbe>
): { themes: GapTheme[]; ungroupedQuestions: number } {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const byText = new Map(groups.map((group) => [oneLine(group.question).toLowerCase(), group.id]));
  const used = new Set<string>();
  const themes: GapTheme[] = [];

  for (const theme of modelThemes) {
    if (themes.length >= MAX_THEMES) break;
    const members: GapQuestionGroup[] = [];
    for (const ref of theme.questionIds) {
      const id = resolveQuestionRef(ref, byText);
      const group = id ? byId.get(id) : undefined;
      if (!id || !group || used.has(id)) continue;
      used.add(id);
      members.push(group);
    }
    const title = clean(theme.title, MAX_TITLE_CHARS);
    if (members.length === 0 || !title) {
      for (const member of members) used.delete(member.id);
      continue;
    }
    members.sort((a, b) => b.count - a.count || b.lastAskedAt.localeCompare(a.lastAskedAt));
    const { kind, source } = classifyTheme(members, probes);
    themes.push({
      title,
      summary: clean(theme.summary, MAX_SUMMARY_CHARS),
      kind,
      refusedCount: members.reduce((sum, m) => sum + m.count, 0),
      flaggedCount: members.reduce((sum, m) => sum + m.flagged, 0),
      questionCount: members.length,
      sampleQuestions: members.slice(0, MAX_SAMPLES).map((m) => oneLine(m.question)),
      source,
      suggestedTitle: kind === "new" ? clean(theme.suggestedSource ?? "", MAX_TITLE_CHARS) || null : null,
      lastAskedAt: members.reduce(
        (latest, m) => (m.lastAskedAt > latest ? m.lastAskedAt : latest),
        members[0]!.lastAskedAt
      )
    });
  }

  themes.sort((a, b) => b.refusedCount - a.refusedCount || b.flaggedCount - a.flaggedCount);
  return { themes, ungroupedQuestions: groups.length - used.size };
}

/**
 * A theme's kind from its questions' retrieval probes, weighted by asks:
 *   covered: most asks now clear the threshold (a source added since answers);
 *   update:  most remaining asks have a near miss, so a source is close;
 *   new:     nothing in the knowledge base is close.
 * The named source is the document that is the best hit for the most asks in
 * the deciding bucket.
 */
export function classifyTheme(
  members: readonly GapQuestionGroup[],
  probes: ReadonlyMap<string, GapProbe>
): { kind: GapThemeKind; source: GapThemeSource | null } {
  const buckets: Record<GapThemeKind, { asks: number; docs: Map<string, { title: string; asks: number }> }> = {
    covered: { asks: 0, docs: new Map() },
    update: { asks: 0, docs: new Map() },
    new: { asks: 0, docs: new Map() }
  };
  for (const member of members) {
    const probe = probes.get(member.id);
    const best = probe?.best ?? null;
    const kind: GapThemeKind =
      !probe || !best
        ? "new"
        : best.score >= probe.threshold
          ? "covered"
          : best.score >= probe.threshold * NEAR_MISS_RATIO
            ? "update"
            : "new";
    const bucket = buckets[kind];
    bucket.asks += member.count;
    if (best && kind !== "new") {
      const doc = bucket.docs.get(best.documentId) ?? { title: best.title, asks: 0 };
      doc.asks += member.count;
      bucket.docs.set(best.documentId, doc);
    }
  }
  const total = buckets.covered.asks + buckets.update.asks + buckets.new.asks;
  const kind: GapThemeKind =
    buckets.covered.asks * 2 > total
      ? "covered"
      : buckets.update.asks >= buckets.new.asks
        ? "update"
        : "new";
  if (kind === "new") return { kind, source: null };
  let top: GapThemeSource | null = null;
  let topAsks = 0;
  for (const [documentId, doc] of buckets[kind].docs) {
    if (doc.asks > topAsks) {
      top = { documentId, title: doc.title };
      topAsks = doc.asks;
    }
  }
  // An update or covered bucket always holds at least one document; guard anyway.
  return top ? { kind, source: top } : { kind: "new", source: null };
}

/** Longest reply and reasoning excerpts kept in the error log. */
export const MAX_LOGGED_REPLY_CHARS = 1_500;
const MAX_LOGGED_LINE_CHARS = 200;

/**
 * Shape of a reply that yielded no usable themes, for the error log: the
 * reply itself (head and tail past MAX_LOGGED_REPLY_CHARS), counts, and the
 * first few raw question references.
 */
export function describeGapReply(
  text: string | null,
  modelThemes: readonly ModelTheme[] | null,
  groups: readonly GapQuestionGroup[]
): Record<string, unknown> {
  const refs = modelThemes?.flatMap((theme) => theme.questionIds) ?? [];
  const byText = new Map(groups.map((group) => [oneLine(group.question).toLowerCase(), group.id]));
  const ids = new Set(groups.map((group) => group.id));
  return {
    replyChars: text?.length ?? 0,
    reply: text ? excerpt(text, MAX_LOGGED_REPLY_CHARS) : null,
    questionsSent: groups.length,
    themesParsed: modelThemes?.length ?? null,
    themesTitled: modelThemes?.filter((theme) => clean(theme.title, MAX_TITLE_CHARS)).length ?? null,
    refsReturned: refs.length,
    refsMatched: refs.filter((ref) => {
      const id = resolveQuestionRef(ref, byText);
      return id !== null && ids.has(id);
    }).length,
    sampleRefs: refs.slice(0, 5).map((ref) => oneLine(ref).slice(0, 60))
  };
}

/**
 * What the model was given, for the error log: question and prompt sizes, how
 * many questions have a near source or read as instructions to a model
 * (content-scan prompt-injection rules), and every question line as the
 * provider received it (after the input firewall), truncated.
 */
export function describeGapInput(
  groups: readonly GapQuestionGroup[],
  probes: ReadonlyMap<string, GapProbe>,
  prompt: { system: string; user: string }
): Record<string, unknown> {
  const instructionLike = groups.filter((group) =>
    scanTextForSensitiveContent(group.question).some((item) => item.category === "prompt_injection")
  );
  let lines: string[] | string;
  try {
    lines = protectProviderText(prompt.user)
      .text.split("\n")
      .slice(1)
      .map((line) => line.slice(0, MAX_LOGGED_LINE_CHARS));
  } catch {
    lines = "withheld: the provider input firewall refused the prompt";
  }
  return {
    questionsSent: groups.length,
    refusedAsksSent: groups.reduce((sum, group) => sum + group.count, 0),
    promptChars: prompt.system.length + prompt.user.length,
    questionsWithSource: groups.filter((group) => probes.get(group.id)?.best).length,
    questionsWithoutProbe: groups.filter((group) => !probes.has(group.id)).length,
    questionsReadingAsInstructions: instructionLike.length,
    instructionLikeIds: instructionLike.map((group) => group.id),
    questionLines: lines
  };
}

/** The text whole when short, else its head and tail around an elision mark. */
export function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max / 3);
  return `${text.slice(0, head)} … [${text.length - max} chars] … ${text.slice(text.length - (max - head))}`;
}

/** Label for the route that produced the analysis. */
export function routeLabel(route: ApprovedModelRoute): { label: string; providerLabel: string } {
  return { label: route.label, providerLabel: route.providerLabel };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clean(text: string, max: number): string {
  const line = oneLine(text).replace(/^["'`]+|["'`]+$/g, "");
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
