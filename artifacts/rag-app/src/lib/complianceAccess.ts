import { hasAtLeastRole, type CurrentUser, type UserRole } from "@/types/api";

/**
 * Who sees the Compliance page, its documents and its question box. Mirrors
 * COMPLIANCE_MIN_ROLE in api-server src/middleware/current-user.ts, which is
 * the enforced check; change both together. This one only picks the screen.
 */
export const COMPLIANCE_MIN_ROLE: UserRole = "super_user";

export function canReadCompliance(user: CurrentUser): boolean {
  return hasAtLeastRole(user, COMPLIANCE_MIN_ROLE);
}

/**
 * Link to a cited passage: the document page marks and scrolls to the span
 * when `v` still matches the document's current content hash.
 */
export function complianceCitationHref(source: {
  slug: string;
  sha256: string;
  source_start: number;
  source_end: number;
}): string {
  const params = new URLSearchParams({
    v: source.sha256,
    from: String(source.source_start),
    to: String(source.source_end)
  });
  return `/compliance/${encodeURIComponent(source.slug)}?${params.toString()}`;
}

/** The cited span from the document page's query string, or null. */
export function readComplianceCitation(
  search: string
): { sha256: string; start: number; end: number } | null {
  const params = new URLSearchParams(search);
  const sha256 = params.get("v");
  const start = Number(params.get("from"));
  const end = Number(params.get("to"));
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  return { sha256, start, end };
}
