import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
const baselinePath = process.argv[3];
if (!root || !baselinePath) {
  console.error(
    "Usage: node check-codeql-sarif.mjs <sarif-directory> <reviewed-baseline.json>",
  );
  process.exit(2);
}

async function findSarifFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findSarifFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".sarif")) {
      files.push(path);
    }
  }

  return files;
}

const files = await findSarifFiles(root);
if (files.length === 0) {
  console.error(`No SARIF files found under ${root}`);
  process.exit(2);
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const reviewed = new Map();
for (const entry of baseline.entries ?? []) {
  for (const fingerprint of entry.fingerprints ?? []) {
    const key = [entry.ruleId, entry.path, fingerprint.hash, fingerprint.column].join(
      "|",
    );
    if (reviewed.has(key)) {
      console.error(`Duplicate reviewed CodeQL fingerprint: ${key}`);
      process.exit(2);
    }
    reviewed.set(key, entry.reason ?? "Reviewed finding");
  }
}

const findings = [];
for (const file of files) {
  const sarif = JSON.parse(await readFile(file, "utf8"));
  for (const run of sarif.runs ?? []) {
    for (const result of run.results ?? []) {
      findings.push({
        ruleId: result.ruleId ?? "unknown-rule",
        level: result.level ?? "warning",
        message: result.message?.text ?? "CodeQL finding",
        location:
          result.locations?.[0]?.physicalLocation?.artifactLocation?.uri ??
          "unknown-location",
        hash: result.partialFingerprints?.primaryLocationLineHash ?? "",
        column:
          result.partialFingerprints?.primaryLocationStartColumnFingerprint ?? "",
      });
    }
  }
}

const matched = new Set();
const unreviewed = findings.filter((finding) => {
  const key = [
    finding.ruleId,
    finding.location,
    finding.hash,
    finding.column,
  ].join("|");
  if (!reviewed.has(key)) return true;
  matched.add(key);
  return false;
});
const stale = [...reviewed.keys()].filter((key) => !matched.has(key));

if (unreviewed.length === 0 && stale.length === 0) {
  console.log(
    `CodeQL gate passed: ${findings.length} reviewed baseline finding(s), 0 unreviewed findings, ${files.length} SARIF file(s).`,
  );
  process.exit(0);
}

console.error(
  `CodeQL gate failed: ${unreviewed.length} unreviewed finding(s), ${stale.length} stale baseline fingerprint(s).`,
);
for (const finding of unreviewed.slice(0, 20)) {
  console.error(
    `- [${finding.level}] ${finding.ruleId} at ${finding.location}: ${finding.message}`,
  );
}
if (unreviewed.length > 20) {
  console.error(`- ${unreviewed.length - 20} additional finding(s) omitted.`);
}
for (const key of stale.slice(0, 20)) {
  console.error(`- Remove or re-review stale baseline fingerprint: ${key}`);
}
if (stale.length > 20) {
  console.error(`- ${stale.length - 20} additional stale fingerprint(s) omitted.`);
}
process.exit(1);
