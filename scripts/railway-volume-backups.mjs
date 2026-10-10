#!/usr/bin/env node
// Show, turn on, or turn off Railway volume backups on the volume mounted on
// pgvector, the production database (docs/security/backup-restore-runbook.md, path A).
// Railway CLI 5.26 has no backup commands, so this calls Railway's public API
// with the token the CLI stores after `railway login`.
//
//   node scripts/railway-volume-backups.mjs              # status only
//   node scripts/railway-volume-backups.mjs --enable     # daily, weekly and monthly schedules, then one manual backup (owner's go first: paid)
//   node scripts/railway-volume-backups.mjs --backup-now # one manual backup, for example before a risky change
//   node scripts/railway-volume-backups.mjs --disable    # remove every schedule (owner's go first)
//
// Railway keeps daily backups 6 days, weekly 27 days and monthly 89 days, and
// bills backups like volume storage for the data exclusive to them
// (https://docs.railway.com/reference/backups). --disable stops new scheduled
// backups; existing backups stay until they expire.
//
// Run from the repo root on a machine with the Railway CLI logged in, or with
// RAILWAY_API_TOKEN set to an account token. Prints no token.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PROJECT = "2aa5cb01-5438-4fbd-aade-626d4e252977";
const ENVIRONMENT = "b35c4090-cbcd-4deb-9434-e9b63a309bd9";
const PGVECTOR_SERVICE = "0d1e7840-7d5e-4a20-a97e-d04f06a88649";
const SCHEDULES = ["DAILY", "WEEKLY", "MONTHLY"];

const flag = process.argv[2];
if (process.argv.length > 3 || (flag !== undefined && !["--enable", "--disable", "--backup-now"].includes(flag))) {
  console.error("usage: node scripts/railway-volume-backups.mjs [--enable | --disable | --backup-now]");
  process.exit(2);
}

const configPath = join(homedir(), ".railway", "config.json");
// `railway login` stores either a token or an OAuth access token; the CLI
// refreshes the access token, this script does not (run `railway whoami`
// first if the API answers "Not Authorized").
const cliUser = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8"))?.user : undefined;
const cliToken = cliUser?.token || cliUser?.accessToken;
const token = process.env.RAILWAY_API_TOKEN || cliToken;
if (!token) {
  console.error("no Railway token: run `railway login` or set RAILWAY_API_TOKEN");
  process.exit(2);
}

async function gql(query, variables = {}) {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`Railway API: HTTP ${res.status} ${(body.errors ?? []).map((e) => e.message).join("; ")}`);
  }
  return body.data;
}

// The volume mounted on pgvector now. After a path A restore that is a new
// volume named for the backup's date stamp, not pgvector-volume, so select by
// service, not by name.
async function volumeInstanceId() {
  const data = await gql(
    `query($id: String!) { project(id: $id) { volumes { edges { node { name volumeInstances { edges { node { id environmentId serviceId } } } } } } } }`,
    { id: PROJECT }
  );
  const mounted = data.project.volumes.edges.flatMap((e) =>
    e.node.volumeInstances.edges
      .map((i) => ({ name: e.node.name, ...i.node }))
      .filter((i) => i.environmentId === ENVIRONMENT && i.serviceId === PGVECTOR_SERVICE)
  );
  if (mounted.length !== 1) throw new Error(`expected one volume mounted on pgvector, found ${mounted.length}`);
  console.log(`volume mounted on pgvector: ${mounted[0].name}`);
  return mounted[0].id;
}

async function status(id) {
  const data = await gql(
    `query($v: String!) {
       volumeInstanceBackupScheduleList(volumeInstanceId: $v) { kind }
       volumeInstanceBackupList(volumeInstanceId: $v) { name createdAt expiresAt usedMB }
     }`,
    { v: id }
  );
  const kinds = data.volumeInstanceBackupScheduleList.map((s) => s.kind).sort();
  console.log(`backup schedules: ${kinds.length ? kinds.join(", ") : "none (backups off)"}`);
  const backups = [...data.volumeInstanceBackupList].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  console.log(`backups: ${backups.length}`);
  for (const b of backups) {
    console.log(`  ${b.createdAt}  ${b.name ?? "(scheduled)"}  expires ${b.expiresAt ?? "never"}  ${b.usedMB ?? "?"} MB`);
  }
  return kinds;
}

try {
  const id = await volumeInstanceId();
  if (flag === "--enable" || flag === "--disable") {
    const kinds = flag === "--enable" ? SCHEDULES : [];
    await gql(
      `mutation($v: String!, $k: [VolumeInstanceBackupScheduleKind!]!) { volumeInstanceBackupScheduleUpdate(volumeInstanceId: $v, kinds: $k) }`,
      { v: id, k: kinds }
    );
    console.log(`schedules set to: ${kinds.length ? kinds.join(", ") : "none"}`);
  }
  if (flag === "--enable" || flag === "--backup-now") {
    const name = `manual-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
    await gql(`mutation($v: String!, $n: String) { volumeInstanceBackupCreate(volumeInstanceId: $v, name: $n) { workflowId } }`, {
      v: id,
      n: name
    });
    console.log(`manual backup requested: ${name} (it can take a minute to appear)`);
  }
  const kinds = await status(id);
  if (flag === "--enable" && kinds.join() !== [...SCHEDULES].sort().join()) {
    console.error("schedules do not match after --enable");
    process.exitCode = 1;
  }
  if (flag === "--disable" && kinds.length > 0) {
    console.error("schedules still present after --disable");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
