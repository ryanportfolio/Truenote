# Evidence API

API of the [evidence harness](evidence-harness.md) for the gated compliance pages. The pages are built elsewhere; this file is the contract between them and `artifacts/api-server/src/routes/admin/evidence.ts`.

All routes under `/api/admin/evidence` require a signed-in `super_user` session with a current password, as the other admin routes do. Reads are limited to 60 requests a minute per user, writes to 10. Times are UTC ISO 8601 strings. Receipts cannot be edited or deleted through any route. The attestation upload is the only route that appends a receipt itself; `POST /runs` has the worker append them.

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

### `POST /attestations/:checkId`

Uploads the proof for one attestation check (`kind: "attestation"` in `GET /catalog`) and appends its receipt. Write limit. Request: `multipart/form-data` with

- `files`: 1 to 10 files, each at most 20 MiB and not empty. Accepted: `.png` sent as `image/png`, `.jpg` or `.jpeg` as `image/jpeg`, `.pdf` as `application/pdf`, `.txt` as `text/plain`, `.csv` as `text/csv`. The declared type (before any `;`) must match the extension, and PNG, JPEG and PDF files must start with their format's magic bytes.
- `statement`: what the files show, 1 to 2,000 characters after trimming.

The body is parsed in memory. Every file is checked before anything is stored. Returns `201`:

```json
{
  "receipt": { "id": "uuid", "sequence": 130, "recordedAt": "...", "receiptHash": "64 hex" },
  "attachments": [
    {
      "key": "evidence/attestations/attestation.access-review/<uuid>/0-<first 16 hex of sha256>.pdf",
      "sha256": "64 hex",
      "bytes": 48213,
      "contentType": "application/pdf"
    }
  ]
}
```

Status codes: `404` for an unknown check id; `400` for a check that is not an attestation (checked before the body is read), a missing or too long statement, no file, a file type that is not accepted or does not match its extension, an empty file, content that does not start with the format's magic bytes, a file in a field other than `files`, or a malformed body; `413` for a file over 20 MiB or more than 10 files.

Side effects: each file is stored in the bucket under `evidence/attestations/<checkId>/<uuid>/<i>-<sha16><ext>`. One transaction appends a receipt of kind `attestation`, result `pass`, whose payload holds the statement, the uploader's id and email, the file names (base name only; letters, digits, `.`, `_`, `-` and spaces; at most 120 characters) and the `attachments` list above, and records the security event `evidence.attestation.recorded` with the check id, receipt sequence and each attachment's key, sha256 and size. When a step after storing fails, the stored objects are deleted, best effort.

### `GET /receipts/:id/attachments/:index`

Downloads attachment `index` (0-based, as listed in the receipt's `payload.attachments`) after checking it against the receipt. Read limit. The file is read from the bucket and its sha256 recomputed; the bytes are served only when it matches the sha256 in the receipt.

`200` with the file as the body, `Content-Type` the recorded type (`application/octet-stream` when it is not one of the five accepted types), `Content-Disposition: attachment` with the recorded file name, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`.

Status codes: `400` for an id that is not a UUID; `404` when the receipt does not exist, has no attachment at that index (an index that is not 1 to 4 digits included), or the attachment's key is not under `evidence/`; `409` when the stored file is missing or its sha256 does not match the receipt, with nothing served:

```json
{ "error": "The stored file does not match the sha256 in the receipt; it is not served." }
```

An error reading the bucket for a file that exists answers `500`.

Side effect of a `409`: the security event `evidence.attestation.attachment_check`, outcome `failure`, with the index, the key, the reason (`missing` or `mismatch`) and the expected and actual sha256 (null for a missing file).

### `GET /summaries`

Every monthly summary receipt (kind `summary`), newest first. Read limit.

```json
{
  "statement": "Self-assessment. ...",
  "summaries": [
    {
      "id": "uuid",
      "sequence": 140,
      "recordedAt": "2026-11-01T05:31:12.000000Z",
      "month": "2026-10",
      "receiptHash": "64 hex",
      "chainHead": { "sequence": 139, "receiptHash": "64 hex", "recordedAt": "..." },
      "counts": { "pass": 20, "fail": 1, "error": 2, "none": 5 }
    }
  ]
}
```

`month` is the UTC calendar month summarized. `chainHead` is the receipt the summary was appended after (null when there was none). `counts` totals the checks summarized by their latest result in the month; `none` counts checks without a receipt that month. The full summary is the receipt's payload (`GET /receipts/:id`, `payload.outputs`). No side effects.

## Public route

`GET /api/evidence/heartbeat`, no sign-in:

```json
{ "lastReceiptAt": "2026-10-11T05:23:09.000000Z", "ageHours": 3.1, "staleAfterHours": 26, "stale": false }
```

`503` with `stale: true` when the store cannot be read. It reveals nothing but the time of the last receipt.
