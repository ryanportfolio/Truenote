export interface ChangeRecordVerification {
  changeId: string | null;
  issues: string[];
}

export const CHANGE_RECORD_HEADINGS = [
  "## Change identity",
  "## Purpose and scope",
  "## Security and PCI impact",
  "## PCI DSS 6.5 change controls",
  "## Verification",
  "## Vulnerabilities and dependencies",
  "## Deployment and secure recovery",
  "## Approval and closure"
] as const;

export const CHANGE_RECORD_FIELDS = [
  "Change ID",
  "Change type",
  "Author",
  "Target release/commit",
  "Target environment",
  "Significant change",
  "Significant-change rationale",
  "Purpose",
  "Affected components and data boundaries",
  "CDE impact",
  "CDE-impact rationale",
  "Security impact and threat considered",
  "6.5.1 bespoke/custom security testing",
  "6.5.1 evidence or rationale",
  "6.5.2 completion revalidation",
  "6.5.2 evidence owner and plan/result",
  "6.5.3 pre-production separation",
  "6.5.3 evidence or rationale",
  "6.5.4 role/function separation",
  "6.5.4 evidence or accountability rationale",
  "6.5.5 live PAN in pre-production",
  "6.5.5 evidence or rationale",
  "6.5.6 test data/accounts removal",
  "6.5.6 evidence owner and plan/result",
  "Commands and results",
  "Negative/security tests",
  "Runtime/integration verification",
  "Evidence not collected locally",
  "Dependency/SBOM impact",
  "Finding/exception links",
  "Deployment/configuration/DDL steps",
  "Post-deployment verification",
  "Failure signal",
  "Secure recovery procedure",
  "Incident ID",
  "Emergency authority",
  "Retrospective review due",
  "Non-author reviewer",
  "Review evidence",
  "Specialist approval",
  "Release/change-authority decision"
] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

function cleanValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("`") && trimmed.endsWith("`")
    ? trimmed.slice(1, -1).trim()
    : trimmed;
}

function placeholder(value: string): boolean {
  return (
    value.length === 0 ||
    /^<[^>]+>$/.test(value) ||
    /\b(?:TBD|TODO|not yet determined|select one)\b/i.test(value) ||
    /`\s*\/\s*`/.test(value) ||
    value === "..."
  );
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function parseFields(markdown: string): { fields: Map<string, string>; issues: string[] } {
  const fields = new Map<string, string>();
  const issues: string[] = [];
  for (const label of CHANGE_RECORD_FIELDS) {
    const pattern = new RegExp(`^- ${escapeRegExp(label)}:\\s*(.*)$`, "gm");
    const matches = [...markdown.matchAll(pattern)];
    if (matches.length === 0) {
      issues.push(`missing field: ${label}`);
      continue;
    }
    if (matches.length > 1) issues.push(`duplicate field: ${label}`);
    const raw = matches[0]?.[1] ?? "";
    const value = cleanValue(raw);
    fields.set(label, value);
    if (placeholder(raw) || placeholder(value)) issues.push(`field is incomplete: ${label}`);
  }
  return { fields, issues };
}

function requireChoice(
  fields: Map<string, string>,
  issues: string[],
  label: string,
  allowed: readonly string[]
): string {
  const value = (fields.get(label) ?? "").toLowerCase();
  if (!allowed.includes(value)) {
    issues.push(`${label} must be exactly one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function verifyChangeRecord(markdown: string): ChangeRecordVerification {
  const source = stripComments(markdown);
  const issues: string[] = [];
  for (const heading of CHANGE_RECORD_HEADINGS) {
    if (!source.split(/\r?\n/).some((line) => line.trim() === heading)) {
      issues.push(`missing section: ${heading}`);
    }
  }
  const parsed = parseFields(source);
  issues.push(...parsed.issues);
  const fields = parsed.fields;

  const changeId = fields.get("Change ID") ?? "";
  if (!/^TN-CHG-\d{4}-\d{3,6}$/.test(changeId)) {
    issues.push("Change ID must match TN-CHG-YYYY-NNN");
  }
  const changeType = requireChoice(fields, issues, "Change type", ["normal", "emergency"]);
  const significant = requireChoice(fields, issues, "Significant change", ["yes", "no"]);
  requireChoice(fields, issues, "CDE impact", ["none", "possible", "in scope"]);
  requireChoice(fields, issues, "6.5.1 bespoke/custom security testing", [
    "completed",
    "not applicable"
  ]);
  const revalidation = requireChoice(fields, issues, "6.5.2 completion revalidation", [
    "planned",
    "completed",
    "not applicable"
  ]);
  requireChoice(fields, issues, "6.5.3 pre-production separation", [
    "confirmed",
    "not applicable"
  ]);
  requireChoice(fields, issues, "6.5.4 role/function separation", [
    "confirmed",
    "not applicable"
  ]);
  requireChoice(fields, issues, "6.5.5 live PAN in pre-production", [
    "no live pan",
    "protected per approved procedure",
    "not applicable"
  ]);
  requireChoice(fields, issues, "6.5.6 test data/accounts removal", [
    "planned",
    "completed",
    "not applicable"
  ]);
  requireChoice(fields, issues, "Release/change-authority decision", ["approved"]);

  if (significant === "yes" && revalidation === "not applicable") {
    issues.push("significant changes cannot mark 6.5.2 completion revalidation not applicable");
  }

  const author = fields.get("Author") ?? "";
  const reviewer = fields.get("Non-author reviewer") ?? "";
  if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(author)) {
    issues.push("Author must be a GitHub username beginning with @");
  }
  if (!/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(reviewer)) {
    issues.push("Non-author reviewer must be a GitHub username beginning with @");
  } else if (author.toLowerCase() === reviewer.toLowerCase()) {
    issues.push("Non-author reviewer must differ from Author");
  }

  const incidentId = fields.get("Incident ID") ?? "";
  const emergencyAuthority = fields.get("Emergency authority") ?? "";
  const retrospectiveDue = fields.get("Retrospective review due") ?? "";
  if (changeType === "emergency") {
    if (placeholder(incidentId) || /^not applicable/i.test(incidentId)) {
      issues.push("emergency changes require an incident ID");
    }
    if (placeholder(emergencyAuthority) || /^not applicable/i.test(emergencyAuthority)) {
      issues.push("emergency changes require an emergency authority");
    }
    if (!validDate(retrospectiveDue)) {
      issues.push("emergency changes require a YYYY-MM-DD retrospective review due date");
    }
  } else if (changeType === "normal") {
    for (const [label, value] of [
      ["Incident ID", incidentId],
      ["Emergency authority", emergencyAuthority],
      ["Retrospective review due", retrospectiveDue]
    ] as const) {
      if (!/^not applicable:\s*.+/i.test(value)) {
        issues.push(`${label} must state not applicable with rationale for a normal change`);
      }
    }
  }

  return {
    changeId: /^TN-CHG-\d{4}-\d{3,6}$/.test(changeId) ? changeId : null,
    issues: [...new Set(issues)]
  };
}

export function verifyChangeRecordTemplate(markdown: string): string[] {
  const issues: string[] = [];
  for (const heading of CHANGE_RECORD_HEADINGS) {
    if (!markdown.split(/\r?\n/).some((line) => line.trim() === heading)) {
      issues.push(`change-record template is missing section: ${heading}`);
    }
  }
  for (const label of CHANGE_RECORD_FIELDS) {
    const pattern = new RegExp(`^- ${escapeRegExp(label)}:`, "m");
    if (!pattern.test(markdown)) issues.push(`change-record template is missing field: ${label}`);
  }
  return issues;
}
