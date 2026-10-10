# Evidence API

Read API of the [evidence harness](evidence-harness.md) for the gated compliance pages. The pages are built elsewhere; this file is the contract between them and `artifacts/api-server/src/routes/admin/evidence.ts`.

All routes under `/api/admin/evidence` require a signed-in `super_user` session with a current password, as the other admin routes do. Reads are limited to 60 requests a minute per user, writes to 10. Times are UTC ISO 8601 strings. Receipts cannot be edited or deleted through any route.

## Shared shapes

`ReceiptSummary`:

```json
{
  "id": "uuid",
  "sequence": 42,
  "recordedAt": "2026-10-11T05:23:04.123456Z",
  "checkId": "external.tls",
  "kind": "external",
  "title": "TLS 1.2+ with a valid certificate; TLS 1.0 and 1.1 refused",
  "result": "pass",
  "runId": "uuid or null",
  "controls": ["SC-8", "SC-8(1)", "SC-13", "SC-17"],
  "objectives": ["SC-08", "SC-08(01)", "SC-13b.", "SC-17a."],
  "summary": "TLS 1.2+ with trusted certificates; TLS 1.0/1.1 refused.",
  "failures": [],
  "receiptHash": "64 hex"
}
```

`result` is `pass`, `fail` or `error`. `error` means the check could not run: no evidence, not a pass. `controls` use the SSP's unpadded labels; `objectives` use NIST's SP 800-53A labels exactly (`AC-02a.[01]`, `AU-09(04)`).

## Routes

### `GET /catalog`

The checks, with control titles from the pinned NIST baseline.

```json
{
  "catalogVersion": "64 hex",
  "statement": "Self-assessment. ...",
  "baseline": { "title": "...", "version": "5.2.0", "sha256": "...", "source": "https://..." },
  "checks": [
    {
      "id": "external.tls",
      "kind": "external",
      "title": "...",
      "controls": ["SC-8"],
      "objectives": ["SC-08"],
      "cadence": "daily",
      "cadenceStatus": "proposed",
      "passCondition": "...",
      "limits": "... (optional)",
      "controlTitles": { "SC-8": "Transmission Confidentiality and Integrity" }
    }
  ]
}
```

### `GET /controls`

Latest result per control. A control's `status` is `fail` if any of its checks last failed, `incomplete` if any last errored or never ran, else `pass`.

```json
{
  "catalogVersion": "...",
  "statement": "...",
  "controls": [
    {
      "control": "AU-9",
      "title": "Protection of Audit Information",
      "status": "pass",
      "checks": [
        {
          "checkId": "database.append-only-refusals",
          "title": "...",
          "objectives": ["AU-09a."],
          "latest": { "id": "uuid", "result": "pass", "recordedAt": "...", "summary": "..." }
        }
      ]
    }
  ]
}
```

### `GET /receipts`

History, newest first. Query: `checkId`, `control` (unpadded, for example `AU-9(4)`), `result`, `before` (a sequence number, for paging), `limit` (1 to 200, default 50).

```json
{ "receipts": [ReceiptSummary], "nextBefore": 17 }
```

`nextBefore` is null on the last page.

### `GET /receipts/:id`

One receipt in full: `ReceiptSummary` plus

```json
{
  "payload": { "schema": "truenote.evidence-receipt/1", "inputs": {}, "outputs": {}, "release": {}, "...": "..." },
  "payloadText": "the exact canonical JSON that was hashed",
  "payloadSha256": "64 hex",
  "previousHash": "64 hex or null"
}
```

`payloadText` lets a reader recompute `receiptHash` with the rule from `GET /chain`.

### `GET /failures`

Checks whose latest receipt is `fail` or `error`.

```json
{
  "statement": "...",
  "failures": [
    {
      "...ReceiptSummary": "",
      "lastPassSequence": 12,
      "knownGaps": [{ "id": "uuid", "poamId": "POAM-2026-004", "note": "...", "expiresOn": "2026-12-31", "expired": false }],
      "tracked": true
    }
  ]
}
```

`tracked` is true for a `fail` with at least one unexpired known-gap link. `lastPassSequence` is null if the check never passed.

### `GET /chain`

```json
{
  "total": 120,
  "headSequence": 120,
  "headHash": "64 hex",
  "firstRecordedAt": "...",
  "lastRecordedAt": "...",
  "hashRule": "receipt_hash = sha256(previous_hash || '|' || id || '|' || recorded_at_text || '|' || sha256(payload)); previous_hash '' for the first receipt",
  "integrity": ["full receipt of the latest integrity.evidence-chain, integrity.security-events-chain and integrity.chain-timestamp"]
}
```

The timestamp receipt's `payload.outputs.token` is the RFC 3161 token, base64.

### `GET /gaps`

All known-gap links, active first.

```json
{ "gaps": [{ "id": "uuid", "checkId": "...", "poamId": "...", "note": "...", "expiresOn": "YYYY-MM-DD or null", "createdAt": "...", "createdBy": "uuid", "retiredAt": null, "retiredBy": null }] }
```

### `POST /gaps`

Body `{ "checkId": "...", "poamId": "...", "note": "...", "expiresOn": "YYYY-MM-DD" | null }`. Returns `201 { "id": "uuid" }`, `400` for an unknown check or bad input, `409` if the same active link exists. Recorded as security event `evidence.known_gap.created`.

### `POST /gaps/:id/retire`

Returns `{ "retired": true }` or `404`. Recorded as `evidence.known_gap.retired`.

### `POST /runs`

Body `{}` for all automated checks or `{ "checkIds": ["external.tls"] }`. Queues a run in the worker and returns `202 { "queued": true, "jobId": "..." }`; `queued` is false when a run was queued in the last 10 minutes. Recorded as `evidence.run.requested`.

## Public route

`GET /api/evidence/heartbeat`, no sign-in:

```json
{ "lastReceiptAt": "2026-10-11T05:23:09.000000Z", "ageHours": 3.1, "staleAfterHours": 26, "stale": false }
```

`503` with `stale: true` when the store cannot be read. It reveals nothing but the time of the last receipt.

## Planned (phases 2 and 3)

These will be added without changing the routes above: an attestation upload route (`POST /attestations/:checkId`, multipart, stored in the bucket under `evidence/`), attachment downloads for receipts, and `GET /summaries` for the monthly summaries.
