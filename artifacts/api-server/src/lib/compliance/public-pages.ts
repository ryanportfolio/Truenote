import path from "node:path";
import { existsSync } from "node:fs";
import { isComplianceSlug } from "./documents.js";

/**
 * Built file for a public compliance summary at /security/compliance/<slug>/,
 * or null when the slug is malformed or no page was built for it. The slug
 * pattern admits only lowercase letters, digits and single hyphens, so the
 * joined path cannot leave dist/security/compliance.
 */
export function publicCompliancePageFile(
  dist: string,
  slug: unknown
): string | null {
  if (!isComplianceSlug(slug)) return null;
  const file = path.join(dist, "security", "compliance", slug, "index.html");
  return existsSync(file) ? file : null;
}
