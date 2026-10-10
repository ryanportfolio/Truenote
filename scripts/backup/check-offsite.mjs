#!/usr/bin/env node
// Weekly check of the off-site backup copy, run from outside Railway with the
// read-only off-site key (docs/security/backup-restore-runbook.md, section 8).
//
//   node scripts/backup/check-offsite.mjs [--max-age-days 8]
//
// Finds the newest manifests/<run id>.json, downloads the object it names and
// checks that the run is recent, that size and SHA-256 match the manifest,
// that the object has a well-formed age header with one X25519 recipient, and
// that no manifest or copy was overwritten: Object Lock keeps every locked
// version, but a stolen write key can upload a newer version under the same
// name, which a plain download would then return. It is the alert for missed
// or broken runs: run weekly as a scheduled task.
//
// The header check cannot prove which key a copy is encrypted to. When
// AGE_BIN and OFFSITE_CHECK_IDENTITY name the age binary and an identity file
// without a passphrase, the check also decrypts the newest copy and looks for
// the dump and the inner manifest in it; otherwise it says that it did not
// decrypt. Only a restore test proves the contents.
//
// Credentials: OFFSITE_S3_ENDPOINT, OFFSITE_S3_REGION, OFFSITE_S3_BUCKET,
// OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY and
// BACKUP_AGE_RECIPIENT from the environment, or the same keys in the JSON file
// named by OFFSITE_CHECK_CONFIG (default ~/.claude/secrets/truenote-offsite-read.json).
// Prints no secret. Exit 0 = pass, 1 = fail, 2 = usage or configuration.
import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let maxAgeDays = 8;
if (args[0] === "--max-age-days" && Number(args[1]) > 0) maxAgeDays = Number(args[1]);
else if (args.length > 0) {
  console.error("usage: node scripts/backup/check-offsite.mjs [--max-age-days N]");
  process.exit(2);
}

const KEYS = [
  "OFFSITE_S3_ENDPOINT",
  "OFFSITE_S3_REGION",
  "OFFSITE_S3_BUCKET",
  "OFFSITE_S3_ACCESS_KEY_ID",
  "OFFSITE_S3_SECRET_ACCESS_KEY",
  "BACKUP_AGE_RECIPIENT"
];
const configPath =
  process.env.OFFSITE_CHECK_CONFIG ?? join(homedir(), ".claude", "secrets", "truenote-offsite-read.json");
const fileConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
const cfg = Object.fromEntries(KEYS.map((k) => [k, process.env[k] ?? fileConfig[k]]));
const ageBin = process.env.AGE_BIN ?? fileConfig.AGE_BIN;
const identity = process.env.OFFSITE_CHECK_IDENTITY ?? fileConfig.OFFSITE_CHECK_IDENTITY;
const missing = KEYS.filter((k) => !cfg[k]);
if (missing.length > 0) {
  console.error(`missing configuration: ${missing.join(", ")}`);
  process.exit(2);
}
const endpoint = new URL(cfg.OFFSITE_S3_ENDPOINT);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// AWS Signature Version 4, path-style request to the bucket.
async function s3Get(key, query = {}) {
  const path = `/${encode(cfg.OFFSITE_S3_BUCKET)}${key ? `/${key.split("/").map(encode).join("/")}` : ""}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k])}`)
    .join("&");
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonical = [
    "GET",
    path,
    qs,
    `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    "host;x-amz-content-sha256;x-amz-date",
    payloadHash
  ].join("\n");
  const scope = `${day}/${cfg.OFFSITE_S3_REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let signingKey = hmac(`AWS4${cfg.OFFSITE_S3_SECRET_ACCESS_KEY}`, day);
  for (const part of [cfg.OFFSITE_S3_REGION, "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  const res = await fetch(`${endpoint.origin}${path}${qs ? `?${qs}` : ""}`, {
    headers: {
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.OFFSITE_S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
    }
  });
  if (!res.ok) throw new Error(`GET ${key || "(list)"}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function listManifests() {
  const keys = [];
  let token;
  do {
    const query = { "list-type": "2", prefix: "manifests/" };
    if (token) query["continuation-token"] = token;
    const xml = (await s3Get("", query)).toString("utf8");
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined;
  } while (token);
  return keys.filter((k) => /^manifests\/\d{8}T\d{6}Z\.json$/.test(k)).sort();
}

// Keys with more than one stored version under the prefixes the job writes.
// Run ids are unique, so a second version of a key means it was overwritten.
async function overwrittenKeys() {
  const counts = new Map();
  for (const prefix of ["manifests/", "weekly/", "monthly/"]) {
    let keyMarker;
    let versionMarker;
    do {
      const query = { versions: "", prefix };
      if (keyMarker) query["key-marker"] = keyMarker;
      if (versionMarker) query["version-id-marker"] = versionMarker;
      const xml = (await s3Get("", query)).toString("utf8");
      for (const m of xml.matchAll(/<Version>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Version>/g)) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      keyMarker = truncated ? xml.match(/<NextKeyMarker>([^<]+)<\/NextKeyMarker>/)?.[1] : undefined;
      versionMarker = truncated ? xml.match(/<NextVersionIdMarker>([^<]+)<\/NextVersionIdMarker>/)?.[1] : undefined;
    } while (keyMarker);
  }
  return [...counts].filter(([, n]) => n > 1).map(([k]) => k);
}

// age v1 header: version line, one or more stanzas, then "--- <MAC>".
// Requires exactly one X25519 stanza with a 32-byte wrapped key, and room for
// the payload nonce and at least one authenticated chunk.
function ageHeaderProblem(body) {
  const end = body.indexOf("\n--- ");
  if (end < 0) return "no age header end";
  const macEnd = body.indexOf("\n", end + 5);
  if (macEnd < 0) return "no age header MAC line";
  const lines = body.subarray(0, end).toString("latin1").split("\n");
  if (lines[0] !== "age-encryption.org/v1") return "not an age v1 file";
  const stanzas = lines.slice(1).filter((l) => l.startsWith("-> "));
  const x25519 = stanzas.filter((l) => /^-> X25519 [A-Za-z0-9+/]{43}$/.test(l));
  if (stanzas.length !== 1 || x25519.length !== 1) return "header does not hold exactly one X25519 recipient";
  const wrapped = lines[lines.indexOf(x25519[0]) + 1] ?? "";
  if (!/^[A-Za-z0-9+/]{43}$/.test(wrapped)) return "X25519 stanza body is not a 32-byte wrapped key";
  if (!/^[A-Za-z0-9+/]{43}$/.test(body.subarray(end + 5, macEnd).toString("latin1"))) return "header MAC is malformed";
  if (body.length - (macEnd + 1) < 16 + 16) return "no encrypted payload after the header";
  return null;
}

const failures = [];
try {
  const manifests = await listManifests();
  if (manifests.length === 0) throw new Error("no manifests in the off-site bucket");
  const overwritten = await overwrittenKeys();
  if (overwritten.length > 0) {
    failures.push(`overwritten after upload (restore an earlier version, runbook section 4.7): ${overwritten.join(", ")}`);
  }
  const newest = manifests[manifests.length - 1];
  let decrypted = false;
  const manifest = JSON.parse((await s3Get(newest)).toString("utf8"));
  const finished = Date.parse(manifest.finished_at);
  const ageDays = (Date.now() - finished) / 86_400_000;
  console.log(`newest run ${manifest.run_id}, finished ${manifest.finished_at} (${ageDays.toFixed(1)} days ago), ${manifests.length} manifests`);
  if (!(ageDays <= maxAgeDays)) failures.push(`newest run is older than ${maxAgeDays} days`);
  if (manifest.age_recipient !== cfg.BACKUP_AGE_RECIPIENT) failures.push("manifest names a different age recipient");
  for (const key of manifest.objects ?? []) {
    const body = await s3Get(key);
    const ok = body.length === manifest.size && sha256(body) === manifest.sha256;
    const problem = ageHeaderProblem(body);
    console.log(`${key}: ${body.length} bytes, ${ok ? "matches manifest" : "DOES NOT match manifest"}, ${problem ? `age header: ${problem}` : "well-formed age header, one X25519 recipient"}`);
    if (!ok) failures.push(`${key} does not match its manifest`);
    if (problem) failures.push(`${key}: ${problem}`);
    if (!decrypted && ok && !problem) decrypted = tryDecrypt(key, body);
  }
  if (decrypted === false) console.log("not decrypted: set AGE_BIN and OFFSITE_CHECK_IDENTITY (an identity without a passphrase) to check the contents");
  if (!(manifest.objects ?? []).length) failures.push("manifest lists no object");
  if (!(manifest.dump_bytes > 0)) failures.push("manifest records an empty dump");
  if (manifest.code_bundle !== true) failures.push("manifest records no code bundle");
  // Files the dump references but the copy lacks: known gaps stay constant;
  // a rise means a file vanished, for example a purge between dump and copy.
  console.log(`referenced files missing from the copy: ${manifest.referenced_files_missing} of ${manifest.referenced_files}`);
  if (manifests.length > 1) {
    const previous = JSON.parse((await s3Get(manifests[manifests.length - 2])).toString("utf8"));
    if (manifest.referenced_files_missing > previous.referenced_files_missing) {
      failures.push(
        `referenced files missing rose from ${previous.referenced_files_missing} to ${manifest.referenced_files_missing}; check which, and run the backup again`
      );
    }
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
}

function tryDecrypt(key, body) {
  if (!ageBin || !identity || !existsSync(ageBin) || !existsSync(identity)) return false;
  if (readFileSync(identity, "latin1").startsWith("age-encryption.org/")) {
    console.log("not decrypted: the identity file is passphrase-protected");
    return "skipped";
  }
  const r = spawnSync(ageBin, ["-d", "-i", identity], { input: body, maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    failures.push(`${key} does not decrypt with the local identity`);
    return "failed";
  }
  const names = r.stdout.toString("latin1");
  const parts = ["./db.dump", "./counts.txt", "./parts.sha256", "./code.bundle"].filter((n) => !names.includes(`${n}\0`));
  if (parts.length > 0) failures.push(`${key} decrypts but lacks ${parts.join(", ")}`);
  else console.log(`${key}: decrypted with the local identity; dump, count record, inner manifest and code bundle present`);
  return "done";
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
