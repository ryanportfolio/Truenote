#!/usr/bin/env node
// Deploy web and worker to Railway production from reviewed main and record
// what shipped in docs/release-register.csv.
//
//   node scripts/railway-deploy.mjs                                   # dry run: checks only
//   node scripts/railway-deploy.mjs --apply -m "<what ships>"         # deploys (owner's go first)
//   node scripts/railway-deploy.mjs --apply -m "<what ships>" --service worker
//
// Refuses unless this checkout is clean, sits at freshly fetched origin/main,
// and the "Security and quality" push run for that commit on main concluded
// success. The upload comes from a temporary LF checkout of the same commit,
// never from this working tree, so ignored local files (build caches, .env
// files) cannot reach the image. Deploys web, waits for SUCCESS, then worker,
// and appends one register row per service, failed attempts included.
// Run from the repo root on a machine with the Railway and GitHub CLIs logged in.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROJECT = "2aa5cb01-5438-4fbd-aade-626d4e252977";
const ENVIRONMENT = "b35c4090-cbcd-4deb-9434-e9b63a309bd9";
const REPO = "ryanportfolio/Truenote";
const CI_WORKFLOW = "security.yml";
const REGISTER = "docs/release-register.csv";
const REGISTER_HEADER =
  "deployed_at_utc,commit,ci_run_id,service,railway_deployment_id,status,image_digest,message";
const SERVICES = ["web", "worker"];
const FINAL = ["SUCCESS", "FAILED", "CRASHED", "REMOVED", "SKIPPED"];
const DEPLOY_TIMEOUT_MS = 25 * 60_000;
const POLL_MS = 15_000;

class Refusal extends Error {}

function parseArgs(argv) {
  const out = { apply: false, message: null, services: SERVICES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") out.apply = true;
    else if (arg === "-m" || arg === "--message") out.message = argv[++i] ?? null;
    else if (arg === "--service") {
      const name = argv[++i];
      if (!SERVICES.includes(name)) throw new Refusal(`--service must be one of ${SERVICES.join(", ")}`);
      out.services = [name];
    } else throw new Refusal(`unknown argument ${arg}`);
  }
  if (out.apply && !out.message) throw new Refusal('--apply needs -m "<what ships>"');
  // The message reaches cmd.exe through the railway.cmd shim; allow only
  // characters that need no escaping inside double quotes there.
  if (out.message !== null && !/^[\w .,:;()#/+-]{1,200}$/.test(out.message)) {
    throw new Refusal("message may use letters, digits, spaces and . , : ; ( ) # / + - only (max 200)");
  }
  return out;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) throw new Refusal(`${command} could not start: ${result.error.message}`);
  return result;
}

function git(args) {
  const result = run("git", args);
  if (result.status !== 0) throw new Refusal(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// railway is an npm .cmd shim on Windows, so it needs a shell. Every argument
// is a fixed id, a service name or the validated message.
function railway(args, options = {}) {
  const quoted = args.map((arg) => (/^[\w./:=-]+$/.test(arg) ? arg : `"${arg}"`));
  return run("railway", quoted, { shell: true, ...options });
}

function checkSource() {
  const top = git(["rev-parse", "--show-toplevel"]);
  if (path.resolve(top) !== path.resolve(process.cwd())) throw new Refusal("run from the repository root");
  git(["fetch", "--quiet", "origin", "main"]);
  const head = git(["rev-parse", "HEAD"]);
  const main = git(["rev-parse", "origin/main"]);
  if (head !== main) {
    throw new Refusal(`HEAD ${head.slice(0, 12)} is not freshly fetched origin/main ${main.slice(0, 12)}`);
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) throw new Refusal(`working tree is not clean:\n${dirty}`);
  return head;
}

function checkCi(sha) {
  const result = run("gh", [
    "api",
    `repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${sha}&event=push&branch=main&per_page=20`
  ]);
  if (result.status !== 0) throw new Refusal(`gh api failed: ${result.stderr.trim()}`);
  const runs = JSON.parse(result.stdout).workflow_runs ?? [];
  const latest = runs.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)[0];
  if (!latest) throw new Refusal(`no "Security and quality" push run on main for ${sha.slice(0, 12)}`);
  if (latest.status !== "completed" || latest.conclusion !== "success") {
    throw new Refusal(
      `CI run ${latest.id} for ${sha.slice(0, 12)} is ${latest.status}/${latest.conclusion ?? "pending"}: ${latest.html_url}`
    );
  }
  return latest;
}

function listDeployments(service) {
  const result = railway(["deployment", "list", "-p", PROJECT, "-e", ENVIRONMENT, "-s", service, "--json", "--limit", "20"]);
  if (result.status !== 0) return [];
  try {
    return JSON.parse(result.stdout);
  } catch {
    return [];
  }
}

async function deploy(service, sourceDir, deployMessage) {
  const startedAt = Date.now();
  const up = railway(
    ["up", "--detach", "-p", PROJECT, "-e", ENVIRONMENT, "-s", service, "-m", deployMessage],
    { cwd: sourceDir, stdio: ["ignore", "inherit", "inherit"] }
  );
  if (up.status !== 0) return { id: "", status: "UPLOAD_FAILED", imageDigest: "" };

  // Found by its exact message, which carries the commit and CI run, and by
  // a creation time after this upload started.
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
  let found = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const deployments = listDeployments(service);
    const current = found
      ? deployments.find((d) => d.id === found.id)
      : deployments.find(
          (d) => d.meta?.cliMessage === deployMessage && Date.parse(d.createdAt) >= startedAt - 60_000
        );
    if (!current) continue;
    found = current;
    console.log(`${service}: ${found.id} ${found.status}`);
    if (FINAL.includes(found.status)) break;
  }
  if (!found) return { id: "", status: "NOT_FOUND", imageDigest: "" };
  return {
    id: found.id,
    status: FINAL.includes(found.status) ? found.status : `TIMEOUT_${found.status}`,
    imageDigest: found.meta?.imageDigest ?? ""
  };
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function record(rows) {
  const lines = rows.map((row) => row.map(csv).join(","));
  const existing = existsSync(REGISTER) ? readFileSync(REGISTER, "utf8").replace(/\r\n/g, "\n") : null;
  if (existing !== null && existing.split("\n")[0] !== REGISTER_HEADER) {
    console.error(`${REGISTER} has an unexpected header; add these rows by hand:`);
    for (const line of lines) console.error(line);
    process.exitCode = 1;
    return;
  }
  if (existing === null) writeFileSync(REGISTER, `${REGISTER_HEADER}\n`);
  appendFileSync(REGISTER, `${lines.join("\n")}\n`);
  console.log(`appended ${rows.length} row(s) to ${REGISTER}; commit it through a pull request.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sha = checkSource();
  const ci = checkCi(sha);
  console.log(`commit: ${sha}`);
  console.log(`CI run: ${ci.id} ${ci.conclusion} ${ci.html_url}`);
  console.log(`services: ${args.services.join(", ")}`);
  if (!args.apply) {
    console.log('dry run: checks passed, nothing deployed. Add --apply -m "<what ships>" after the owner\'s go.');
    return;
  }

  // LF checkout of the exact commit: the bytes GitHub and CI hold.
  const sourceDir = mkdtempSync(path.join(os.tmpdir(), `truenote-release-${sha.slice(0, 12)}-`));
  git(["-c", "core.autocrlf=false", "-c", "core.eol=lf", "worktree", "add", "--detach", sourceDir, sha]);
  const rows = [];
  try {
    if (git(["-C", sourceDir, "rev-parse", "HEAD"]) !== sha) {
      throw new Refusal("temporary checkout is not at the release commit");
    }
    const deployMessage = `${sha.slice(0, 12)} ci ${ci.id}: ${args.message}`;
    for (const service of args.services) {
      const result = await deploy(service, sourceDir, deployMessage);
      rows.push([new Date().toISOString(), sha, ci.id, service, result.id, result.status, result.imageDigest, args.message]);
      console.log(`${service}: ${result.status} ${result.id} ${result.imageDigest}`);
      if (result.status !== "SUCCESS") {
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    const removed = run("git", ["worktree", "remove", "--force", sourceDir]);
    if (removed.status !== 0) console.error(`remove the temporary checkout by hand: ${sourceDir}`);
    if (rows.length > 0) record(rows);
  }
}

main().catch((error) => {
  console.error(error instanceof Refusal ? `refused: ${error.message}` : error);
  process.exitCode = error instanceof Refusal ? 2 : 1;
});
