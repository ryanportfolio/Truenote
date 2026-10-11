import { sql } from "drizzle-orm";
import { db } from "../db-client.js";
import {
  getActiveModelChain,
  type ApprovedModelRoute
} from "../generation/model-routing.js";
import { runUtilityCompletion } from "../generation/utility-model.js";
import { recordAppError } from "../observability/error-log.js";

/**
 * Where new eval questions come from, besides an admin typing them:
 * - suggestions: questions CSRs asked that went wrong (refused, flagged as
 *   missing content, or thumbs-down) in the selected program;
 * - drafts: questions with expected answers a model writes from one source's
 *   current-version excerpts. Nothing here saves a question.
 */

export const MAX_SUGGESTIONS = 50;
export const DRAFT_EXCERPT_CHAR_LIMIT = 12_000;
export const DRAFT_TEXT_MAX = 2000;
const DRAFT_TIMEOUT_MS = 60_000;
const EXCERPT_SEPARATOR = "\n\n---\n\n";

export interface QuestionSuggestion {
  question: string;
  askCount: number;
  lastAskedAt: string;
  outcome: "refused" | "flagged";
  alreadyInSet: boolean;
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/**
 * Asked questions in the program from the last `days` days that were refused,
 * flagged as missing content, or rated thumbs-down, grouped by their trimmed
 * lower-case text. Most-asked first, then most recent.
 */
export async function loadQuestionSuggestions(
  programId: string,
  days: number
): Promise<QuestionSuggestion[]> {
  const result = await db.execute(sql`
    WITH matched AS (
      SELECT btrim(question) AS question,
             lower(btrim(question)) AS question_key,
             created_at,
             refused IS TRUE AS refused
      FROM query_log
      WHERE program_id = ${programId}::uuid
        AND created_at >= now() - make_interval(days => ${days}::int)
        AND (refused IS TRUE OR flagged_missing IS TRUE OR feedback < 0)
        AND btrim(question) <> ''
    ),
    grouped AS (
      SELECT question_key,
             (array_agg(question ORDER BY created_at DESC))[1] AS question,
             count(*)::int AS ask_count,
             max(created_at) AS last_asked_at,
             bool_or(refused) AS any_refused
      FROM matched
      GROUP BY question_key
    )
    SELECT g.question,
           g.ask_count,
           g.last_asked_at,
           g.any_refused,
           EXISTS (
             SELECT 1
             FROM eval_questions eq
             WHERE eq.program_id = ${programId}::uuid
               AND lower(btrim(eq.question)) = g.question_key
           ) AS already_in_set
    FROM grouped g
    ORDER BY g.ask_count DESC, g.last_asked_at DESC
    LIMIT ${MAX_SUGGESTIONS}
  `);
  return (
    result.rows as Array<{
      question: string;
      ask_count: unknown;
      last_asked_at: unknown;
      any_refused: unknown;
      already_in_set: unknown;
    }>
  ).map((row) => ({
    question: row.question,
    askCount: Number(row.ask_count),
    lastAskedAt: isoString(row.last_asked_at),
    outcome: row.any_refused === true ? "refused" : "flagged",
    alreadyInSet: row.already_in_set === true
  }));
}

/**
 * Chunk text of the document's current version, in ordinal order, joined and
 * capped at DRAFT_EXCERPT_CHAR_LIMIT characters. Program-scoped on both the
 * document and the chunks.
 */
export async function loadDocumentExcerpts(
  programId: string,
  documentId: string
): Promise<string> {
  const result = await db.execute(sql`
    SELECT c.content
    FROM documents d
    JOIN chunks c
      ON c.document_version_id = d.current_version_id
     AND c.program_id = ${programId}::uuid
    WHERE d.id = ${documentId}::uuid
      AND d.program_id = ${programId}::uuid
    ORDER BY c.ordinal ASC NULLS LAST, c.id ASC
  `);
  return joinExcerpts(
    (result.rows as Array<{ content: string }>).map((row) => row.content)
  );
}

/** Join excerpts until the character cap; the first excerpt is cut to fit. */
export function joinExcerpts(
  contents: string[],
  limit: number = DRAFT_EXCERPT_CHAR_LIMIT
): string {
  let text = "";
  for (const raw of contents) {
    const content = raw.trim();
    if (!content) continue;
    if (!text) {
      text = content.slice(0, limit);
      if (content.length >= limit) break;
      continue;
    }
    const next = text + EXCERPT_SEPARATOR + content;
    if (next.length > limit) break;
    text = next;
  }
  return text;
}

export interface QuestionDraftPrompt {
  system: string;
  user: string;
}

export function buildQuestionDraftPrompt(input: {
  documentTitle: string;
  excerpts: string;
  count: number;
}): QuestionDraftPrompt {
  const system = [
    "You write evaluation questions for a knowledge assistant used by call-center customer service reps (CSRs).",
    `Write exactly ${input.count} realistic questions a CSR might ask during a call that the excerpts below answer.`,
    "For each question give the expected answer in one or two sentences.",
    "Use only facts stated in the excerpts. Never invent fees, dates, numbers, policy names or procedures.",
    "Skip a question rather than guess. Each question must be answerable from the excerpts alone.",
    'Reply with JSON only, no prose and no code fences: {"items":[{"question":"...","expectedAnswer":"..."}]}'
  ].join("\n");
  const user = [
    `Source: ${input.documentTitle}`,
    "",
    "Excerpts:",
    input.excerpts
  ].join("\n");
  return { system, user };
}

export interface DraftedQuestion {
  question: string;
  expectedAnswer: string;
}

/**
 * Read the model's reply: the text from the first "{" to the last "}" must
 * parse as JSON with an `items` array. Keeps items with a non-empty question
 * and expected answer within DRAFT_TEXT_MAX characters, at most `count`.
 * Returns null when nothing usable is in the reply.
 */
export function parseQuestionDraftReply(
  text: string,
  count: number
): DraftedQuestion[] | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  const items =
    parsed && typeof parsed === "object" && "items" in parsed
      ? (parsed as { items: unknown }).items
      : null;
  if (!Array.isArray(items)) return null;
  const out: DraftedQuestion[] = [];
  for (const item of items) {
    if (out.length >= count) break;
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question =
      typeof record.question === "string" ? record.question.trim() : "";
    const expectedAnswer =
      typeof record.expectedAnswer === "string"
        ? record.expectedAnswer.trim()
        : "";
    if (!question || !expectedAnswer) continue;
    if (question.length > DRAFT_TEXT_MAX || expectedAnswer.length > DRAFT_TEXT_MAX) {
      continue;
    }
    out.push({ question, expectedAnswer });
  }
  return out.length > 0 ? out : null;
}

export class QuestionDraftUnavailableError extends Error {
  constructor() {
    super("Drafting failed. Try again.");
    this.name = "QuestionDraftUnavailableError";
  }
}

export interface QuestionDraftDeps {
  chain?: ApprovedModelRoute[];
  complete?: typeof runUtilityCompletion;
}

/**
 * Walk the answers chain: a route that throws, or whose reply holds no usable
 * item, records a warning and hands over to the next route. Throws
 * QuestionDraftUnavailableError when every route fails.
 */
export async function draftQuestionsWithChain(
  input: {
    programId: string;
    documentTitle: string;
    excerpts: string;
    count: number;
  },
  deps: QuestionDraftDeps = {}
): Promise<DraftedQuestion[]> {
  const chain = deps.chain ?? (await getActiveModelChain("answers"));
  const complete = deps.complete ?? runUtilityCompletion;
  const prompt = buildQuestionDraftPrompt(input);
  for (const route of chain) {
    try {
      const text = await complete(
        { ...prompt, timeoutMs: DRAFT_TIMEOUT_MS, maxRetries: 0, json: true },
        { route }
      );
      const items = text ? parseQuestionDraftReply(text, input.count) : null;
      if (!items) throw new Error("reply held no usable draft questions");
      return items;
    } catch (error) {
      void recordAppError({
        severity: "warning",
        source: "evaluation",
        operation: "question-draft",
        error,
        provider: route.provider,
        model: route.model,
        routeId: route.id,
        programId: input.programId
      });
    }
  }
  throw new QuestionDraftUnavailableError();
}
