import {
  scanTextForSensitiveContent,
  type SecurityFinding
} from "./content-scan.js";

export interface AskContentHistoryTurn {
  question: string;
  answer: string;
}

/**
 * Return blocking metadata for every user-controlled text field that can enter
 * the ask pipeline. Findings contain rule/count only; matched text is never
 * returned. The route calls this before session creation, rewrite, retrieval,
 * provider invocation, query logging, session naming, or response assembly.
 */
export function blockingAskContentFindings(
  question: string,
  history: readonly AskContentHistoryTurn[]
): SecurityFinding[] {
  const text = [
    question,
    ...history.flatMap((turn) => [turn.question, turn.answer])
  ].join("\n");
  return scanTextForSensitiveContent(text).filter(
    (finding) =>
      finding.blocking &&
      (finding.category === "pii" || finding.category === "secret")
  );
}
