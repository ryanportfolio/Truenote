export type DocumentPolicyDecision =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

export interface DocumentApprovalInput {
  reviewerId: string;
  uploadedBy: string | null;
  lifecycleState: string;
  parseStatus: string;
  scanStatus: string;
  sourceId: string | null;
  sourceActive: boolean | null;
  sourceApprovedAt: Date | string | null;
  findings: unknown;
  acknowledgeFindings: boolean;
}

function securityFindings(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null,
      )
    : [];
}

/** Pure, fail-closed approval policy used by the route and negative tests. */
export function evaluateDocumentApproval(
  input: DocumentApprovalInput,
): DocumentPolicyDecision {
  if (
    input.lifecycleState !== "pending_review" ||
    input.parseStatus !== "ready"
  ) {
    return {
      allowed: false,
      status: 409,
      error: "Document is not awaiting review.",
    };
  }
  if (input.scanStatus !== "clean") {
    return {
      allowed: false,
      status: 409,
      error: "Document has no clean malware-scan verdict.",
    };
  }
  if (!input.sourceId || !input.sourceActive || !input.sourceApprovedAt) {
    return {
      allowed: false,
      status: 409,
      error: "Document source is no longer approved.",
    };
  }
  if (input.uploadedBy === input.reviewerId) {
    return {
      allowed: false,
      status: 409,
      error: "A different authorized reviewer must approve this upload.",
    };
  }
  const findings = securityFindings(input.findings);
  if (findings.some((finding) => finding["blocking"] === true)) {
    return {
      allowed: false,
      status: 409,
      error:
        "Blocking secret, PII, or file-safety findings must be resolved before approval.",
    };
  }
  if (findings.length > 0 && !input.acknowledgeFindings) {
    return {
      allowed: false,
      status: 400,
      error: "Acknowledge the scan findings before approval.",
    };
  }
  return { allowed: true };
}

export interface DocumentPurgeInput {
  title: unknown;
  confirmTitle: string;
  lifecycleState: unknown;
  retentionElapsed: boolean;
  retentionOverrideEnabled: boolean;
}

/** Pure irreversible-deletion gate used by the route and negative tests. */
export function evaluateDocumentPurge(
  input: DocumentPurgeInput,
): DocumentPolicyDecision {
  if (input.title !== input.confirmTitle) {
    return {
      allowed: false,
      status: 400,
      error: "Document title confirmation does not match.",
    };
  }
  if (input.lifecycleState !== "retired") {
    return {
      allowed: false,
      status: 409,
      error: "Retire the document before permanent purge.",
    };
  }
  if (!input.retentionElapsed && !input.retentionOverrideEnabled) {
    return {
      allowed: false,
      status: 409,
      error: "Document retention period has not elapsed.",
    };
  }
  return { allowed: true };
}
