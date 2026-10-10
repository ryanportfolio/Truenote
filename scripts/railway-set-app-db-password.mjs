#!/usr/bin/env node
// Set or rotate the password of a login role without printing it anywhere:
// truenote_app, the application's role (lib/db/sql/0007_app_runtime_role.sql),
// or with --role backup, truenote_backup, the backup job's read-only role
// (lib/db/sql/0014_backup_role.sql).
//
//   node scripts/railway-set-app-db-password.mjs [--role backup]          # status only
//   node scripts/railway-set-app-db-password.mjs [--role backup] --apply  # new password (owner's go first)
//
// --apply generates a random password in memory and:
//   1. stores it in the pgvector service variable TRUENOTE_APP_DB_PASSWORD
//      (TRUENOTE_BACKUP_DB_PASSWORD for --role backup; --stdin, --skip-deploys:
//      pgvector is not redeployed), which web and worker reference in
//      DATABASE_URL and the backup service in BACKUP_DATABASE_URL;
//   2. sets the role's password to a SCRAM-SHA-256 verifier computed here, so
//      the plaintext never reaches the database server, its logs or psql;
//   3. checks that the stored verifier is the one computed here.
// Running services keep their open connections; new connections use the new
// password only after web and worker are redeployed, so redeploy both right
// after a rotation (.claude/reference/deployment.md, "Database roles"). The
// backup service starts fresh on each scheduled run and needs no redeploy.
//
// Run from the repo root on a machine with the Railway CLI logged in.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const PROJECT = "2aa5cb01-5438-4fbd-aade-626d4e252977";
const ENVIRONMENT = "b35c4090-cbcd-4deb-9434-e9b63a309bd9";
const SERVICE = "pgvector";
const ROLES = {
  app: { role: "truenote_app", variable: "TRUENOTE_APP_DB_PASSWORD", sql: "0007_app_runtime_role.sql" },
  backup: { role: "truenote_backup", variable: "TRUENOTE_BACKUP_DB_PASSWORD", sql: "0014_backup_role.sql" }
};

const args = process.argv.slice(2);
let which = "app";
if (args[0] === "--role") {
  which = args[1];
  args.splice(0, 2);
}
const flag = args[0];
if (!(which in ROLES) || args.length > 1 || (flag !== undefined && flag !== "--apply")) {
  console.error("usage: node scripts/railway-set-app-db-password.mjs [--role backup] [--apply]");
  process.exit(2);
}
const { role: ROLE, variable: VARIABLE, sql: SQL_FILE } = ROLES[which];

const psql =
  'psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -A -t -q -v ON_ERROR_STOP=1';

function remote(script) {
  const b64 = Buffer.from(script).toString("base64");
  const result = spawnSync(
    "railway",
    ["ssh", "-p", PROJECT, "-e", ENVIRONMENT, "-s", SERVICE, "--", `"echo ${b64} | base64 -d | sh"`],
    { encoding: "utf8", shell: true }
  );
  return { status: result.status ?? 1, out: (result.stdout ?? "").trim(), err: result.stderr ?? "" };
}

function railwayVariableNames() {
  const result = spawnSync(
    "railway",
    ["variable", "list", "-p", PROJECT, "-e", ENVIRONMENT, "-s", SERVICE, "--json"],
    { encoding: "utf8", shell: true }
  );
  if (result.status !== 0) return null;
  return Object.keys(JSON.parse(result.stdout));
}

// RFC 5802 / RFC 7677 verifier in PostgreSQL's stored format.
function scramVerifier(password) {
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

const roleState = remote(
  [
    "set -eu",
    `${psql} <<'SQL'`,
    `SELECT CASE WHEN r.oid IS NULL THEN 'role missing' ELSE format('role %s: login=%s superuser=%s createrole=%s createdb=%s password=%s', r.rolname, r.rolcanlogin::text, r.rolsuper::text, r.rolcreaterole::text, r.rolcreatedb::text, CASE WHEN a.rolpassword IS NULL THEN 'unset' ELSE 'set' END) END FROM (SELECT 1) AS one LEFT JOIN pg_roles AS r ON r.rolname = '${ROLE}' LEFT JOIN pg_authid AS a ON a.oid = r.oid;`,
    "SQL"
  ].join("\n")
);
if (roleState.status !== 0) {
  process.stderr.write(roleState.err);
  console.error("could not read the role state");
  process.exit(roleState.status);
}
const names = railwayVariableNames();
console.log(roleState.out);
console.log(`${SERVICE} variable ${VARIABLE}: ${names === null ? "unknown (railway variable list failed)" : names.includes(VARIABLE) ? "present" : "absent"}`);

if (flag !== "--apply") process.exit(0);
if (!roleState.out.startsWith(`role ${ROLE}: login=true superuser=false`)) {
  console.error(`refusing: ${ROLE} must exist as a non-superuser login role (apply ${SQL_FILE} first)`);
  process.exit(3);
}

// Hex keeps the password safe inside a connection URL without escaping.
const password = randomBytes(32).toString("hex");
const verifier = scramVerifier(password);

const set = spawnSync(
  "railway",
  ["variable", "set", VARIABLE, "--stdin", "--skip-deploys", "-p", PROJECT, "-e", ENVIRONMENT, "-s", SERVICE],
  { input: password, encoding: "utf8", shell: true }
);
if (set.status !== 0) {
  console.error(`railway variable set failed (exit ${set.status}); the role password was not changed`);
  process.exit(set.status ?? 1);
}
console.log(`${SERVICE} variable ${VARIABLE}: set (no redeploy)`);

const alter = remote(
  [
    "set -eu",
    `${psql} <<'SQL'`,
    `ALTER ROLE ${ROLE} PASSWORD '${verifier}';`,
    `SELECT CASE WHEN rolpassword = '${verifier}' THEN 'verifier stored' ELSE 'verifier mismatch' END FROM pg_authid WHERE rolname = '${ROLE}';`,
    "SQL"
  ].join("\n")
);
if (alter.status !== 0 || alter.out !== "verifier stored") {
  console.error(
    `setting the role password failed (exit ${alter.status}): ${alter.out || "no output"}. ` +
      `${VARIABLE} already holds the new password; rerun --apply before any redeploy.`
  );
  process.exit(alter.status || 1);
}
console.log(`role ${ROLE}: verifier stored`);
if (which === "app") console.log("Redeploy web and worker if their DATABASE_URL uses this role.");
