import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("Usage: node check-codeql-sarif.mjs <sarif-directory>");
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
      });
    }
  }
}

if (findings.length === 0) {
  console.log(`CodeQL gate passed: 0 findings across ${files.length} SARIF file(s).`);
  process.exit(0);
}

console.error(`CodeQL gate failed: ${findings.length} finding(s).`);
for (const finding of findings.slice(0, 20)) {
  console.error(
    `- [${finding.level}] ${finding.ruleId} at ${finding.location}: ${finding.message}`,
  );
}
if (findings.length > 20) {
  console.error(`- ${findings.length - 20} additional finding(s) omitted.`);
}
process.exit(1);
