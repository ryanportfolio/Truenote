/**
 * The compliance corpus and customer knowledge never meet (security boundary,
 * like program scoping). Compliance text lives only in object storage under
 * compliance/ and in the web process's compliance index; customer knowledge
 * lives in Postgres. These tests pin the code paths that keep them apart:
 *
 * - customer pipelines (CSR ask, knowledge base, gaps, evals, ingestion,
 *   scripts) never import the compliance modules, so they cannot reach the
 *   compliance index or its documents;
 * - the compliance modules never import the database client or customer
 *   retrieval directly, so a compliance answer cannot read customer chunks;
 *   its only database read is the answer chain order in app_settings, through
 *   generation/model-routing (compliance-ask.test.ts checks no query touches
 *   chunks, documents, document_versions or query_log);
 * - a compliance passage handed to generation carries a scope that no
 *   program id can equal, so customer scope filtering drops it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterToProgramScope } from "../../retrieval/query.js";
import { COMPLIANCE_SCOPE, passageAsChunk } from "../ask.js";
import { chunkComplianceDocument } from "../chunking.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(here, "../../..");
const repoRoot = path.resolve(apiSrc, "../../..");
const complianceDir = path.join(apiSrc, "lib", "compliance");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

interface ImportRef {
  target: string;
  typeOnly: boolean;
}

/** Relative imports of a file, resolved to absolute paths without extension. */
function importsOf(file: string): ImportRef[] {
  const text = readFileSync(file, "utf8");
  const refs: ImportRef[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    const specifier = match[3] ?? match[4];
    if (!specifier || !specifier.startsWith(".")) continue;
    refs.push({
      target: path.resolve(path.dirname(file), specifier).replace(/\.(js|ts|tsx)$/, ""),
      typeOnly: Boolean(match[2])
    });
  }
  return refs;
}

const relative = (file: string): string => path.relative(repoRoot, file).split(path.sep).join("/");

describe("compliance isolation", () => {
  it("only the compliance route and the public pages server import compliance modules", () => {
    const files = [...sourceFiles(apiSrc), ...sourceFiles(path.join(repoRoot, "scripts", "src"))];
    const importers = new Map<string, Set<string>>();
    for (const file of files) {
      if (file.startsWith(complianceDir + path.sep)) continue;
      for (const ref of importsOf(file)) {
        if (!ref.target.startsWith(complianceDir + path.sep)) continue;
        const module = path.basename(ref.target);
        const set = importers.get(relative(file)) ?? new Set<string>();
        set.add(module);
        importers.set(relative(file), set);
      }
    }
    const found = Object.fromEntries(
      [...importers.entries()].map(([file, modules]) => [file, [...modules].sort()])
    );
    expect(found).toEqual({
      "artifacts/api-server/src/app.ts": ["public-pages"],
      // Warms the compliance index at startup.
      "artifacts/api-server/src/index.ts": ["search-index"],
      "artifacts/api-server/src/routes/compliance.ts": ["ask", "documents", "providers", "search-index", "suggestions"],
      // The owner's upload script writes documents and the manifest; it never reads the index.
      "scripts/src/upload-compliance-docs.ts": ["documents"]
    });
  });

  it("compliance modules never import the database client or customer retrieval", () => {
    const forbidden = [
      path.join(apiSrc, "lib", "db-client"),
      path.join(apiSrc, "lib", "retrieval", "query"),
      path.join(apiSrc, "lib", "retrieval", "rerank"),
      path.join(apiSrc, "lib", "ingestion", "embedder"),
      path.join(apiSrc, "lib", "ingestion", "run")
    ];
    const violations: string[] = [];
    for (const file of sourceFiles(complianceDir)) {
      for (const ref of importsOf(file)) {
        if (!ref.typeOnly && forbidden.includes(ref.target)) {
          violations.push(`${relative(file)} -> ${relative(ref.target)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("customer scope filtering drops a compliance passage for any program", () => {
    const [passage] = chunkComplianceDocument(
      { slug: "plan-of-action", title: "Plan", version: "1", sha256: "b".repeat(64) },
      "## Weakness\n\nFixture weakness.\n"
    );
    const chunk = passageAsChunk({ passage: passage!, score: 1, neighbor: false });
    expect(chunk.programId).toBe(COMPLIANCE_SCOPE);
    const scoped = filterToProgramScope([chunk], "00000000-0000-4000-8000-000000000001");
    expect(scoped.kept).toEqual([]);
    expect(scoped.dropped).toEqual([chunk]);
  });
});
