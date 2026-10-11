import { useId, useState } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type MetricName =
  | "Overall pass"
  | "Answer accuracy"
  | "Citation accuracy"
  | "Out-of-KB refused"
  | "Retrieval recall"
  | "Rerank recall"
  | "In-KB refusal"
  | "Faithfulness"
  | "Expected source rank"
  | "Generation fallback"
  | "Failure stage";

/** One plain sentence per metric, shown when the admin asks. */
export const METRIC_HELP: Record<MetricName, string> = {
  "Overall pass":
    "Share of questions with the right outcome: a correct, cited answer when the documents cover it, or a refusal when they don't.",
  "Answer accuracy":
    "Of the answerable questions with expected phrases or an expected answer, the share whose answer contained every phrase and was graded correct against the expected answer.",
  "Citation accuracy":
    "Of the answerable questions with an expected source, the share whose answer cited that source.",
  "Out-of-KB refused":
    "Of the questions the documents don't cover, the share the assistant refused instead of guessing.",
  "Retrieval recall":
    "Of the questions with an expected source, the share where search found that source among its candidates.",
  "Rerank recall":
    "Of the questions with an expected source, the share where that source stayed in the excerpts the model reads after reranking.",
  "In-KB refusal":
    "Share of answerable questions the assistant refused; lower is better, because each one is an answer a CSR didn't get.",
  Faithfulness:
    "With the faithfulness judge on, how much of each answer the cited excerpts support, averaged over the answers it scored.",
  "Expected source rank":
    "Average position of the expected source among the excerpts the model reads, counting only questions where it was found; 1 means it came first.",
  "Generation fallback":
    "Questions answered by a later model in the chain because the first one failed or timed out.",
  "Failure stage":
    "For each failed answerable question, the step where it went wrong: search, reranking, the confidence threshold, or writing the answer."
};

/**
 * Info button plus its explanation. The caller places `button` next to the
 * metric label and `text` where the explanation should open.
 */
export function useMetricHelp(metric: MetricName): {
  button: JSX.Element;
  text: JSX.Element;
} {
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    button: (
      <button
        type="button"
        className={cn("btn-icon p-0.5", open && "bg-muted text-foreground")}
        aria-label={`What is ${metric}?`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((current) => !current)}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
    ),
    text: (
      <p
        id={id}
        hidden={!open}
        className="mt-1 text-xs normal-case leading-relaxed tracking-normal text-muted-foreground"
      >
        {METRIC_HELP[metric]}
      </p>
    )
  };
}
