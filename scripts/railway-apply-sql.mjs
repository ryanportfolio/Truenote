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
// Sets $state to no-table, not-applied or the recorded sha256. Two queries:
// a reference to a missing table fails at parse time even inside a CASE
// branch that would never run. Both run as plain assignments so `set -e`
// stops on a database error instead of reading it as an empty ledger.
const readState = [
  `ledger=$(${psql} -A -t -c "SELECT to_regclass('public.schema_migrations')")`,
  `if [ -z "$ledger" ]; then state=no-table; else state=$(${psql} -A -t -c "SELECT coalesce((SELECT sha256 FROM schema_migrations WHERE filename = '${name}'), 'not-applied')"); fi`
];
const script = apply
  ? [
      "set -eu",
      ...readState,
      `if [ "$state" != "not-applied" ] && [ "$state" != "no-table" ]; then echo "already applied: $state"; exit 3; fi`,
      // A private temp file, checked against the local hash, so the bytes
      // executed are the bytes recorded. The advisory lock serializes
      // concurrent runs; a second run of the same file then fails on the
      // schema_migrations primary key and rolls back.
      'tmp=$(mktemp)',
      'trap \'rm -f "$tmp"\' EXIT',
      `echo ${Buffer.from(sql).toString("base64")} | base64 -d > "$tmp"`,
      `echo "${sha}  $tmp" | sha256sum -c --quiet -`,
      `${psql} --single-transaction -c "SELECT pg_advisory_xact_lock(hashtext('truenote.schema_migrations'))" -f "$tmp" -c "INSERT INTO schema_migrations (filename, sha256) VALUES ('${name}', '${sha}')"`,
      `echo "applied ${name} ${sha}"`
    ].join("\n")
  : ["set -eu", ...readState, `echo "status ${name}: $state"`, `echo "local sha256: ${sha}"`].join("\n");

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
