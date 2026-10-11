import type OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import { z } from "zod";
import { protectProviderText } from "../security/provider-input-firewall.js";
import { getDeadlineConfig } from "../deadlines.js";
import {
  JUDGE_MODEL,
  JUDGE_PROVIDER,
  JUDGE_REASONING_EFFORT,
  getJudgeClient,
  type JudgeProviderField
} from "./faithfulness.js";

/**
 * Answer-correctness judge: grades whether a generated answer conveys the
 * eval question's expected answer. Faithfulness checks grounding in the
 * excerpts; this checks that the answer says the right thing. Same model,
 * client and ZDR-pinned OpenRouter route as the faithfulness judge.
 */
export const CorrectnessSchema = z.object({
  verdict: z.enum(["correct", "partial", "incorrect"]),
  /** One short sentence naming what is missing or wrong. */
  reason: z.string()
});

export type CorrectnessJudgment = z.infer<typeof CorrectnessSchema>;

export interface JudgeAnswerCorrectnessInput {
  question: string;
  expectedAnswer: string;
  answer: string;
}

const CORRECTNESS_SYSTEM_PROMPT = [
  "You are a strict grader for a customer-service knowledge assistant.",
  "",
  "Grade whether the ANSWER conveys the EXPECTED ANSWER for the QUESTION.",
  "  correct   = the answer conveys the expected key facts; a paraphrase counts.",
  "  partial   = the answer conveys some but not all of the expected key facts.",
  "  incorrect = a key fact is missing or contradicted, or the answer is a refusal.",
  "",
  "Rules:",
  "- Extra correct detail does not lower the grade.",
  "- reason is one short sentence naming what is missing or wrong."
].join("\n");

export async function judgeAnswerCorrectness(
  input: JudgeAnswerCorrectnessInput,
  deps: { client?: OpenAI } = {}
): Promise<CorrectnessJudgment> {
  const client = deps.client ?? getJudgeClient();
  const question = protectProviderText(input.question).text;
  const expectedAnswer = protectProviderText(input.expectedAnswer).text;
  const answer = protectProviderText(input.answer).text;
  const userPrompt = `QUESTION:\n${question}\n\nEXPECTED ANSWER:\n${expectedAnswer}\n\nANSWER:\n${answer}`;

  const { faithfulness } = getDeadlineConfig();
  const request = {
    model: JUDGE_MODEL,
    reasoning_effort: JUDGE_REASONING_EFFORT,
    messages: [
      { role: "system" as const, content: CORRECTNESS_SYSTEM_PROMPT },
      { role: "user" as const, content: userPrompt }
    ],
    response_format: zodResponseFormat(CorrectnessSchema, "correctness")
  };
  const completion = await client.beta.chat.completions.parse(
    { ...request, provider: JUDGE_PROVIDER } as typeof request & JudgeProviderField,
    {
      timeout: faithfulness.timeoutMs,
      maxRetries: faithfulness.maxRetries
    }
  );

  const parsed = completion.choices[0]?.message.parsed;
  if (!parsed) {
    throw new Error("Correctness judge failed to produce a valid judgment");
  }
  return parsed;
}
