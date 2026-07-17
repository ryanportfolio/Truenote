# CodeQL SARIF intake and reconciliation

**Evidence grade:** Implemented, unverified  
**Owner:** Vulnerability-management owner — unassigned  
**Scope:** Repository-safe intake of retained CodeQL SARIF into the PCI
vulnerability baseline

This procedure turns a retained CodeQL scan into a safe, reviewable finding
baseline. It does not close findings, approve exceptions, determine PCI scope, or
replace GitHub code-scanning alerts and restricted scanner evidence.

## Safety boundary

Raw SARIF stays in the approved restricted evidence location. Do not commit it.
The importer writes only:

- workflow run, commit, artifact identity, availability, expiry, and SHA-256;
- explicit commit binding through SARIF provenance or the matching GitHub Actions
  run receipt;
- aggregate severity and rule-group counts;
- stable `TN-CQL-*` identifiers;
- rule and vulnerability-register identifiers;
- security severity and a one-way location fingerprint; and
- management fields for owner, date, disposition, approval, exception expiry,
  and retest artifact.

Messages, source paths, line/column numbers, snippets, related locations,
customer data, credentials, and exploit detail are never copied to the safe
baseline. Seven SARIF/source tests enforce safe fields, state, identity,
provenance, chronology, closure, and reconciliation; an eighth importer test
verifies atomic replacement and concurrent-edit protection.

## Preconditions

1. Download the SARIF artifact from the reviewed GitHub Actions run into
   restricted temporary storage.
2. Record the repository, run ID, commit SHA, artifact ID/name, artifact expiry,
   and the timestamp when availability was verified.
3. Independently calculate/obtain the raw `javascript.sarif` SHA-256. Verify the
   run completed for the intended commit and preserve the GitHub run receipt in
   the restricted evidence system.
4. Ensure every new CodeQL rule has a reviewed `TN-VULN-*` register group. Never
   map a new rule merely to make the import pass.

## Dry run

Run from the repository root, replacing every bracketed value:

```powershell
corepack pnpm --filter @workspace/scripts run import:codeql -- `
  --sarif <restricted-sarif-path> `
  --run-id <github-run-id> `
  --commit <40-character-commit-sha> `
  --run-receipt-url <matching-github-actions-run-url> `
  --artifact-id <github-artifact-id> `
  --expected-artifact-sha256 <raw-javascript-sarif-sha256> `
  --artifact-expires-at <iso-timestamp> `
  --verified-available-at <iso-timestamp>
```

The default is dry-run only. It reports counts of imported, preserved, added,
and removed safe IDs without printing raw findings.

For a newly observed rule, first create or approve its repository-safe register
group, then add a repeatable mapping argument:

```text
--map js/example-rule=TN-VULN-2026-009
```

The importer fails closed when a rule lacks a mapping, a stable SARIF partial
fingerprint is missing, a safe fingerprint is duplicated, source metadata is
invalid, the artifact hash differs, the tool is not CodeQL, SARIF provenance or
the external run receipt does not bind the claimed commit, a result is suppressed,
absent, or non-failing, or the generated baseline does not reconcile to the
exact `TN-VULN-*` register row. A non-idempotent rescan must use a newer run ID,
new artifact ID, and later availability timestamp than the current baseline.

If SARIF contains version-control provenance, use
`--commit-binding sarif-provenance` and omit `--run-receipt-url`. Otherwise the
default external-run-receipt binding and matching URL are required. Every SARIF
run containing results must use the selected binding; one provenanced run cannot
lend commit identity to another unprovenanced run.

## Rescan preservation and removals

The `codeql-location-v1` fingerprint hashes the rule ID, normalized artifact URI,
CodeQL primary-location line hash, and CodeQL start-column fingerprint. Line
movement alone therefore preserves the safe ID and all existing owner/date/
disposition evidence.

A finding still present in the current SARIF cannot be marked `closed`. It may
remain open, mitigated, not affected through approved review, or covered by an
approved exception. Closure requires a later scan to stop reporting the exact
fingerprint plus the removal reconciliation below.

A result missing from a later scan is not automatically closed. By default, the
import fails and lists only the affected safe IDs. Before using
`--allow-removed`, the vulnerability-management owner must:

1. reconcile the exact prior finding in restricted evidence;
2. confirm whether remediation, changed applicability, or scan drift caused the
   removal;
3. retain the clean-scan/retest artifact;
4. record the approved closure or other disposition in the register; and
5. link that record in the restricted system.

`--allow-removed` acknowledges completed reconciliation. The importer still
requires each removed safe record to contain an owner, approver, terminal status
and disposition, plus the required retest artifact or unexpired exception. It
does not create a closure, approval, or exception. Removed records move to
`historicalFindings`; their management evidence, fingerprint, and ID remain
retained, exception expiry remains enforceable, and their IDs cannot be reused.
If a later scan re-reports a historical fingerprint, the import fails until the
record is explicitly reviewed and reopened.

Closed and not-affected history must have an exact child row in the register’s
`Closed items` section containing both the `TN-CQL-*` safe finding ID and parent
`TN-VULN-*` group, closure date, approver, retest, and restricted evidence.
Historical approved exceptions use the separate `Historical exceptions` section.
An open group row cannot satisfy either requirement.

## Write and verify

After reviewing the dry-run summary, repeat the command with `--write`. Then run:

```powershell
corepack pnpm --filter @workspace/scripts run verify:vulnerabilities
corepack pnpm --filter @workspace/scripts run verify:vulnerabilities:release
corepack pnpm --filter @workspace/scripts run verify:pci-evidence
```

The structural gate must pass for every change. The managed-release gate covers
this CodeQL baseline plus the broader 11-category vulnerability-source register
and must pass before release; a failure is an unresolved accountability/control
state, not permission to waive the result.

Writes use a same-directory temporary file, flush it, and atomically rename it.
Immediately before replacement, the importer compares the baseline to the bytes
read at startup; it aborts if another process or reviewer changed the file, so
management decisions cannot be silently overwritten.

## One-time schema migration record

On 2026-07-16 the initial unmanaged schema-v1 snapshot was migrated to the
versioned schema-v3 model
with `--migrate-v1-unmanaged`. The migration guard verified that every legacy
finding was still `open`, unassigned, undated, and `pending`, with no approval,
exception, or retest evidence. It then regenerated all 51 fingerprints using the
documented versioned algorithm. This flag refuses a managed legacy finding and
must not be used for normal rescans.

## Acceptance test

Using synthetic SARIF only:

- raw path and message markers are absent from serialized output;
- severities and rule groups reconcile exactly;
- moved lines retain IDs and management fields;
- a removed finding fails closed without explicit acknowledgement;
- terminal removed records remain as immutable-ID history, and reappearance
  fails closed;
- an active scanner result marked closed fails structurally;
- historical closure in the wrong register section fails;
- stale/older scan sources and mixed per-run provenance fail;
- duplicate locations fail; and
- an unmapped new rule, suppression/absent state, or non-CodeQL input fails.

Retain the passing test receipt, dry-run summary, final safe-baseline hash, hosted
scan receipt, reviewer, and any reconciliation/closure records.
