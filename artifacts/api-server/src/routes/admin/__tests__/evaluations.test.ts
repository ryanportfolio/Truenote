import { describe, expect, it } from "vitest";
import { EvalQuestionBody } from "../evaluations.js";

describe("EvalQuestionBody", () => {
  it("requires an expectation for in-KB questions", () => {
    expect(
      EvalQuestionBody.safeParse({ kind: "in-kb", question: "What is the fee?" })
        .success
    ).toBe(false);
  });

  it("allows intentional out-of-KB refusal questions without expectations", () => {
    const parsed = EvalQuestionBody.safeParse({
      kind: "out-of-kb",
      question: "What is the CEO's favorite color?"
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.expectedAnswerContains).toEqual([]);
    }
  });

  it("trims expected phrases at the boundary", () => {
    const parsed = EvalQuestionBody.safeParse({
      kind: "in-kb",
      question: "What is the cancellation fee?",
      expectedAnswerContains: ["  $25  "]
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.expectedAnswerContains).toEqual(["$25"]);
    }
  });
});
