import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { isComplianceSlug } from "./documents.js";

/**
 * Built public compliance summaries, read once at startup: slug to the
 * index.html file under dist/security/compliance/<slug>/. Only directories
 * whose names pass the slug pattern and that contain an index.html are
 * listed. Requests look a slug up in this map; a request value never becomes
 * part of a file path.
 */
export function listPublicCompliancePages(dist: string): ReadonlyMap<string, string> {
  const root = path.join(dist, "security", "compliance");
  const pages = new Map<string, string>();
  if (!existsSync(root)) return pages;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isComplianceSlug(entry.name)) continue;
    const file = path.join(root, entry.name, "index.html");
    if (existsSync(file)) pages.set(entry.name, file);
  }
  return pages;
}

/** The built file for a requested slug, or null when no page was built for it. */
export function publicCompliancePageFile(
  pages: ReadonlyMap<string, string>,
  slug: unknown
): string | null {
  if (typeof slug !== "string") return null;
  return pages.get(slug) ?? null;
}
