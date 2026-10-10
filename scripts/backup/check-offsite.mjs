#!/usr/bin/env node
// Weekly check of the off-site backup copy, run from outside Railway with the
// read-only off-site key (docs/security/backup-restore-runbook.md, section 8).
//
//   node scripts/backup/check-offsite.mjs [--max-age-days 8]
//
// Finds the newest manifests/<run id>.json, downloads the object it names and
// checks that the run is recent, that size and SHA-256 match the manifest,
// and that the object is an age file encrypted to the expected recipient.
// This catches what the dead-man's switch cannot: a backup job that still
// pings but uploads nothing useful. It cannot decrypt (it has no private key);
// only a restore test proves the contents.
//
// Credentials: OFFSITE_S3_ENDPOINT, OFFSITE_S3_REGION, OFFSITE_S3_BUCKET,
// OFFSITE_S3_ACCESS_KEY_ID, OFFSITE_S3_SECRET_ACCESS_KEY and
// BACKUP_AGE_RECIPIENT from the environment, or the same keys in the JSON file
// named by OFFSITE_CHECK_CONFIG (default ~/.claude/secrets/truenote-offsite-read.json).
// Prints no secret. Exit 0 = pass, 1 = fail, 2 = usage or configuration.
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

const failures = [];
try {
  const manifests = await listManifests();
  if (manifests.length === 0) throw new Error("no manifests in the off-site bucket");
  const newest = manifests[manifests.length - 1];
  const manifest = JSON.parse((await s3Get(newest)).toString("utf8"));
  const finished = Date.parse(manifest.finished_at);
  const ageDays = (Date.now() - finished) / 86_400_000;
  console.log(`newest run ${manifest.run_id}, finished ${manifest.finished_at} (${ageDays.toFixed(1)} days ago), ${manifests.length} manifests`);
  if (!(ageDays <= maxAgeDays)) failures.push(`newest run is older than ${maxAgeDays} days`);
  if (manifest.age_recipient !== cfg.BACKUP_AGE_RECIPIENT) failures.push("manifest names a different age recipient");
  for (const key of manifest.objects ?? []) {
    const body = await s3Get(key);
    const ok = body.length === manifest.size && sha256(body) === manifest.sha256;
    const header = body.subarray(0, 64).toString("latin1");
    const isAge = header.startsWith("age-encryption.org/v1\n-> X25519 ");
    console.log(`${key}: ${body.length} bytes, ${ok ? "matches manifest" : "DOES NOT match manifest"}, ${isAge ? "age X25519 header" : "NOT an age X25519 file"}`);
    if (!ok) failures.push(`${key} does not match its manifest`);
    if (!isAge) failures.push(`${key} is not an age file`);
  }
  if (!(manifest.objects ?? []).length) failures.push("manifest lists no object");
  if (!(manifest.dump_bytes > 0)) failures.push("manifest records an empty dump");
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL: ${f}`);
  process.exitCode = 1;
} else {
  console.log("PASS");
}
