#!/usr/bin/env node
// Apply one lib/db/sql/NNNN_<name>.sql file to the Railway production
// database in a single transaction and record it in schema_migrations.
// Runs psql inside the `pgvector` service over `railway ssh`.
//
//   node scripts/railway-apply-sql.mjs lib/db/sql/0002_example.sql          # dry run: prints status
//   node scripts/railway-apply-sql.mjs lib/db/sql/0002_example.sql --apply  # applies (owner's go first)
//
// Run from the repo root on a machine with the Railway CLI logged in.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = "2aa5cb01-5438-4fbd-aade-626d4e252977";
const ENVIRONMENT = "b35c4090-cbcd-4deb-9434-e9b63a309bd9";
const SERVICE = "pgvector";
const MAX_B64 = 6500; // Windows caps the command line near 8,000 characters.

const [file, flag] = process.argv.slice(2);
if (!file || !/^\d{4}_[a-z0-9_]+\.sql$/.test(path.basename(file))) {
  console.error("usage: node scripts/railway-apply-sql.mjs lib/db/sql/NNNN_<name>.sql [--apply]");
  process.exit(2);
}
const apply = flag === "--apply";
const sql = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const name = path.basename(file);
const sha = createHash("sha256").update(sql).digest("hex");

const psql =
  'psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1';
// Two queries: a reference to a missing table fails at parse time even
// inside a CASE branch that would never run.
const recorded = `if [ -z "$(${psql} -A -t -c "SELECT to_regclass('public.schema_migrations')")" ]; then echo no-table; else ${psql} -A -t -c "SELECT coalesce((SELECT sha256 FROM schema_migrations WHERE filename = '${name}'), 'not-applied')"; fi`;
const script = apply
  ? [
      "set -eu",
      `state=$(${recorded})`,
      `if [ "$state" != "not-applied" ] && [ "$state" != "no-table" ]; then echo "already applied: $state"; exit 3; fi`,
      `echo ${Buffer.from(sql).toString("base64")} | base64 -d > /tmp/${name}`,
      `${psql} --single-transaction -f /tmp/${name} -c "INSERT INTO schema_migrations (filename, sha256) VALUES ('${name}', '${sha}')"`,
      `rm -f /tmp/${name}`,
      `echo "applied ${name} ${sha}"`
    ].join("\n")
  : ["set -eu", `echo "status ${name}: $(${recorded})"`, `echo "local sha256: ${sha}"`].join("\n");

const b64 = Buffer.from(script).toString("base64");
if (b64.length > MAX_B64) {
  console.error(`${name} is too large to send in one railway ssh call (${b64.length} base64 chars); split it.`);
  process.exit(2);
}
const result = spawnSync(
  "railway",
  ["ssh", "-p", PROJECT, "-e", ENVIRONMENT, "-s", SERVICE, "--", `"echo ${b64} | base64 -d | sh"`],
  { stdio: "inherit", shell: true }
);
process.exitCode = result.status ?? 1;
