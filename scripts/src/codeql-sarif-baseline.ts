import { createHash } from "node:crypto";
import {
  CODEQL_FINGERPRINT_VERSION,
  type SafeCodeqlBaseline,
  type SafeCodeqlFinding,
  type VulnerabilitySeverity,
  severityFromSecurityScore,
  VULNERABILITY_SEVERITIES
} from "./vulnerability-baseline.js";

export interface CodeqlImportSource {
  repository: string;
  runId: number;
  commit: string;
  commitBinding: "sarif-provenance" | "external-run-receipt";
  runReceiptUrl: string | null;
  artifactId: number;
  artifactName: string;
  artifactSha256: string;
  artifactExpiresAt: string;
  verifiedAvailableAt: string;
}

export interface CodeqlImportSummary {
  imported: number;
  preservedFindingIds: string[];
  addedFindingIds: string[];
  removedFindingIds: string[];
}

export interface CodeqlImportResult {
  baseline: SafeCodeqlBaseline;
  summary: CodeqlImportSummary;
}

interface ExtractedFinding {
  ruleId: string;
  securitySeverity: string | null;
  severity: VulnerabilitySeverity;
  locationFingerprintSha256: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeArtifactUri(uri: string): string {
  return uri.replaceAll("\\", "/").replace(/^\.\//, "").normalize("NFC");
}

function canonicalPart(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`SARIF result lacks a safe ${label}`);
  }
  return value;
}

export function codeqlLocationFingerprint(input: {
  ruleId: string;
  uri: string;
  primaryLocationLineHash: string;
  primaryLocationStartColumnFingerprint: string;
}): string {
  const canonical = [
    CODEQL_FINGERPRINT_VERSION,
    canonicalPart(input.ruleId, "rule ID"),
    normalizeArtifactUri(canonicalPart(input.uri, "artifact URI")),
    canonicalPart(input.primaryLocationLineHash, "primary-location line hash"),
    canonicalPart(
      input.primaryLocationStartColumnFingerprint,
      "primary-location column fingerprint"
    )
  ].join("\0");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizedSecurityScore(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 10) {
    throw new Error(`CodeQL rule has invalid security-severity: ${String(value)}`);
  }
  return String(numeric);
}

function collectRuleScores(run: Record<string, unknown>): Map<string, string | null> {
  const scores = new Map<string, string | null>();
  const tool = record(run.tool);
  const components = [record(tool?.driver), ...array(tool?.extensions).map(record)].filter(
    (component): component is Record<string, unknown> => component !== null
  );
  for (const component of components) {
    for (const rawRule of array(component.rules)) {
      const rule = record(rawRule);
      if (!rule || typeof rule.id !== "string") continue;
      const properties = record(rule.properties);
      const score = normalizedSecurityScore(properties?.["security-severity"]);
      const existing = scores.get(rule.id);
      if (existing !== undefined && existing !== score) {
        throw new Error(`CodeQL rule ${rule.id} has conflicting security severities`);
      }
      scores.set(rule.id, score);
    }
  }
  return scores;
}

function extractFindings(sarif: unknown, source: CodeqlImportSource): ExtractedFinding[] {
  const root = record(sarif);
  if (!root || root.version !== "2.1.0") {
    throw new Error("CodeQL input must be SARIF 2.1.0");
  }
  const runs = array(root.runs);
  if (runs.length === 0) throw new Error("SARIF contains no runs");
  const findings: ExtractedFinding[] = [];
  const fingerprints = new Set<string>();

  for (const rawRun of runs) {
    const run = record(rawRun);
    if (!run) throw new Error("SARIF run must be an object");
    const tool = record(run.tool);
    const driver = record(tool?.driver);
    if (driver?.name !== "CodeQL") throw new Error("SARIF tool driver must be CodeQL");
    const provenances = array(run.versionControlProvenance).map(record).filter(
      (provenance): provenance is Record<string, unknown> => provenance !== null
    );
    for (const provenance of provenances) {
      if (provenance.revisionId !== source.commit) {
        throw new Error("SARIF version-control provenance does not match the claimed commit");
      }
    }
    const ruleScores = collectRuleScores(run);
    const results = array(run.results);
    if (results.length > 0 && source.commitBinding === "sarif-provenance" && provenances.length === 0) {
      throw new Error("every SARIF run containing results must include matching commit provenance");
    }
    if (results.length > 0 && source.commitBinding === "external-run-receipt" && provenances.length > 0) {
      throw new Error("source commit binding must use SARIF provenance when result runs include it");
    }
    for (const rawResult of results) {
      const result = record(rawResult);
      if (!result) throw new Error("SARIF result must be an object");
      const ruleId = canonicalPart(result.ruleId, "rule ID");
      if (result.kind !== undefined && result.kind !== "fail") {
        throw new Error(`CodeQL result ${ruleId} has non-actionable SARIF kind ${String(result.kind)}`);
      }
      if (
        result.baselineState !== undefined &&
        !new Set(["new", "unchanged", "updated"]).has(String(result.baselineState))
      ) {
        throw new Error(
          `CodeQL result ${ruleId} has unsupported SARIF baselineState ${String(result.baselineState)}`
        );
      }
      if (array(result.suppressions).length > 0) {
        throw new Error(`CodeQL result ${ruleId} contains a suppression requiring explicit review`);
      }
      const location = record(array(result.locations)[0]);
      const physical = record(location?.physicalLocation);
      const artifact = record(physical?.artifactLocation);
      const partial = record(result.partialFingerprints);
      const fingerprint = codeqlLocationFingerprint({
        ruleId,
        uri: canonicalPart(artifact?.uri, "artifact URI"),
        primaryLocationLineHash: canonicalPart(
          partial?.primaryLocationLineHash,
          "primary-location line hash"
        ),
        primaryLocationStartColumnFingerprint: canonicalPart(
          partial?.primaryLocationStartColumnFingerprint,
          "primary-location column fingerprint"
        )
      });
      if (fingerprints.has(fingerprint)) {
        throw new Error(`SARIF contains a duplicate safe fingerprint for ${ruleId}`);
      }
      fingerprints.add(fingerprint);
      const score = ruleScores.get(ruleId) ?? null;
      findings.push({
        ruleId,
        securitySeverity: score,
        severity: severityFromSecurityScore(score),
        locationFingerprintSha256: fingerprint
      });
    }
  }
  return findings.sort((left, right) =>
    left.ruleId.localeCompare(right.ruleId) ||
    left.locationFingerprintSha256.localeCompare(right.locationFingerprintSha256)
  );
}

const IMPORT_SOURCE_KEYS = [
  "repository",
  "runId",
  "commit",
  "commitBinding",
  "runReceiptUrl",
  "artifactId",
  "artifactName",
  "artifactSha256",
  "artifactExpiresAt",
  "verifiedAvailableAt"
] as const satisfies readonly (keyof CodeqlImportSource)[];

function assertSourceProgression(existing: unknown, incoming: CodeqlImportSource): void {
  const root = record(existing);
  const prior = record(root?.source);
  if (!prior) return;

  const exactReplay = IMPORT_SOURCE_KEYS.every((key) => prior[key] === incoming[key]);
  if (exactReplay) return;

  if (prior.repository !== incoming.repository) {
    throw new Error("incoming scan repository does not match the existing baseline");
  }
  if (!Number.isSafeInteger(prior.runId) || incoming.runId <= Number(prior.runId)) {
    throw new Error("incoming scan run ID must be newer than the existing baseline run");
  }
  if (prior.artifactId === incoming.artifactId) {
    throw new Error("incoming scan reuses the existing artifact ID");
  }
  const priorVerifiedAt = Date.parse(String(prior.verifiedAvailableAt));
  const incomingVerifiedAt = Date.parse(incoming.verifiedAvailableAt);
  if (
    !Number.isFinite(priorVerifiedAt) ||
    !Number.isFinite(incomingVerifiedAt) ||
    incomingVerifiedAt <= priorVerifiedAt
  ) {
    throw new Error("incoming scan availability time must be later than the existing baseline");
  }
}

function ruleMappingsFromBaseline(existing: unknown): Map<string, string> {
  const mappings = new Map<string, string>();
  const root = record(existing);
  for (const rawGroup of array(root?.ruleGroups)) {
    const group = record(rawGroup);
    if (typeof group?.ruleId === "string" && typeof group.registerId === "string") {
      mappings.set(group.ruleId, group.registerId);
    }
  }
  for (const rawFinding of [...array(root?.findings), ...array(root?.historicalFindings)]) {
    const finding = record(rawFinding);
    if (typeof finding?.ruleId === "string" && typeof finding.registerId === "string") {
      const current = mappings.get(finding.ruleId);
      if (current && current !== finding.registerId) {
        throw new Error(`existing baseline has conflicting register mappings for ${finding.ruleId}`);
      }
      mappings.set(finding.ruleId, finding.registerId);
    }
  }
  return mappings;
}

function existingFindings(existing: unknown): SafeCodeqlFinding[] {
  const root = record(existing);
  if (root?.schemaVersion !== 3) return [];
  return array(root.findings).filter(
    (finding): finding is SafeCodeqlFinding => record(finding) !== null
  );
}

function existingHistoricalFindings(existing: unknown): SafeCodeqlFinding[] {
  const root = record(existing);
  if (root?.schemaVersion !== 3) return [];
  return array(root.historicalFindings).filter(
    (finding): finding is SafeCodeqlFinding => record(finding) !== null
  );
}

function nextFindingId(existing: SafeCodeqlFinding[], year: number): () => string {
  const pattern = new RegExp(`^TN-CQL-${year}-(\\d+)$`);
  let sequence = existing.reduce((maximum, finding) => {
    const match = pattern.exec(finding.id);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  return () => `TN-CQL-${year}-${String(++sequence).padStart(3, "0")}`;
}

function newFinding(
  id: string,
  extracted: ExtractedFinding,
  registerId: string
): SafeCodeqlFinding {
  return {
    id,
    registerId,
    ruleId: extracted.ruleId,
    severity: extracted.severity,
    securitySeverity: extracted.securitySeverity,
    locationFingerprintSha256: extracted.locationFingerprintSha256,
    status: "open",
    owner: null,
    due: null,
    disposition: "pending",
    approver: null,
    exceptionExpires: null,
    retestArtifact: null
  };
}

export function buildSafeCodeqlBaseline(input: {
  sarif: unknown;
  source: CodeqlImportSource;
  existing?: unknown;
  ruleMappings?: ReadonlyMap<string, string>;
  allowRemoved?: boolean;
}): CodeqlImportResult {
  assertSourceProgression(input.existing, input.source);
  const extracted = extractFindings(input.sarif, input.source);
  const mappings = ruleMappingsFromBaseline(input.existing);
  for (const [ruleId, registerId] of input.ruleMappings ?? []) {
    const existingMapping = mappings.get(ruleId);
    if (existingMapping && existingMapping !== registerId) {
      throw new Error(
        `CodeQL rule ${ruleId} is already mapped to ${existingMapping}; remapping requires a reviewed baseline/register change`
      );
    }
    mappings.set(ruleId, registerId);
  }
  for (const finding of extracted) {
    if (!mappings.has(finding.ruleId)) {
      throw new Error(`CodeQL rule ${finding.ruleId} has no vulnerability-register mapping`);
    }
  }

  const prior = existingFindings(input.existing);
  const priorHistory = existingHistoricalFindings(input.existing);
  const priorByFingerprint = new Map(
    prior.map((finding) => [finding.locationFingerprintSha256, finding] as const)
  );
  const historicalByFingerprint = new Map(
    priorHistory.map((finding) => [finding.locationFingerprintSha256, finding] as const)
  );
  const seenPriorIds = new Set<string>();
  const year = new Date(input.source.verifiedAvailableAt).getUTCFullYear();
  if (!Number.isInteger(year)) throw new Error("source availability timestamp is invalid");
  const allocateId = nextFindingId([...prior, ...priorHistory], year);
  const findings: SafeCodeqlFinding[] = [];
  const preservedFindingIds: string[] = [];
  const addedFindingIds: string[] = [];

  for (const finding of extracted) {
    const registerId = mappings.get(finding.ruleId)!;
    const historicalFinding = historicalByFingerprint.get(finding.locationFingerprintSha256);
    if (historicalFinding) {
      throw new Error(
        `scan re-reports historical finding ${historicalFinding.id}; review and reopen it before import`
      );
    }
    const priorFinding = priorByFingerprint.get(finding.locationFingerprintSha256);
    if (priorFinding) {
      if (priorFinding.status === "closed" || priorFinding.disposition === "closed") {
        throw new Error(
          `scan still reports closed finding ${priorFinding.id}; review and reopen it before import`
        );
      }
      seenPriorIds.add(priorFinding.id);
      preservedFindingIds.push(priorFinding.id);
      findings.push({
        ...priorFinding,
        registerId,
        ruleId: finding.ruleId,
        severity: finding.severity,
        securitySeverity: finding.securitySeverity,
        locationFingerprintSha256: finding.locationFingerprintSha256
      });
    } else {
      const id = allocateId();
      addedFindingIds.push(id);
      findings.push(newFinding(id, finding, registerId));
    }
  }

  const removedFindingIds = prior
    .filter((finding) => !seenPriorIds.has(finding.id))
    .map((finding) => finding.id)
    .sort();
  if (removedFindingIds.length > 0 && !input.allowRemoved) {
    throw new Error(
      `scan no longer reports ${removedFindingIds.length} prior findings; reconcile/retest them before using --allow-removed: ${removedFindingIds.join(", ")}`
    );
  }
  if (removedFindingIds.length > 0 && input.allowRemoved) {
    const today = new Date(input.source.verifiedAvailableAt).toISOString().slice(0, 10);
    const unreconciled = prior.filter((finding) => {
      if (!removedFindingIds.includes(finding.id)) return false;
      if (!finding.owner?.trim() || !finding.approver?.trim()) return true;
      if (finding.status === "closed" && finding.disposition === "closed") {
        return !finding.retestArtifact?.trim();
      }
      if (finding.status === "not_affected" && finding.disposition === "not_affected") {
        return !finding.retestArtifact?.trim();
      }
      if (
        finding.status === "accepted_exception" &&
        finding.disposition === "accepted_exception"
      ) {
        return !finding.exceptionExpires || finding.exceptionExpires < today;
      }
      return true;
    });
    if (unreconciled.length > 0) {
      throw new Error(
        `--allow-removed refuses findings without an owned, approved terminal disposition and required retest/expiry: ${unreconciled.map((finding) => finding.id).join(", ")}`
      );
    }
  }

  findings.sort((left, right) => left.id.localeCompare(right.id));
  const historicalFindings = [
    ...priorHistory,
    ...prior.filter((finding) => removedFindingIds.includes(finding.id))
  ].sort((left, right) => left.id.localeCompare(right.id));
  const severityCounts = Object.fromEntries(
    VULNERABILITY_SEVERITIES.map((severity) => [
      severity,
      findings.filter((finding) => finding.severity === severity).length
    ])
  ) as Record<VulnerabilitySeverity, number>;
  const groupCounts = new Map<string, number>();
  for (const finding of findings) {
    groupCounts.set(finding.ruleId, (groupCounts.get(finding.ruleId) ?? 0) + 1);
  }

  return {
    baseline: {
      schemaVersion: 3,
      fingerprintVersion: CODEQL_FINGERPRINT_VERSION,
      source: {
        ...input.source,
        resultCount: findings.length,
        severityCounts
      },
      ruleGroups: [...groupCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([ruleId, resultCount]) => ({
          ruleId,
          registerId: mappings.get(ruleId)!,
          resultCount
        })),
      findings,
      historicalFindings
    },
    summary: {
      imported: findings.length,
      preservedFindingIds: preservedFindingIds.sort(),
      addedFindingIds: addedFindingIds.sort(),
      removedFindingIds
    }
  };
}
