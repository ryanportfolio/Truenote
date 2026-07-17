# PCI change register template

**Template status:** Unfilled; not operating evidence

**Owner:** Change authority - unassigned

**System of record:** `<approved system and controlled register reference>`

Use this register to identify the complete population of production changes that
can affect Truenote or a connected CDE. The register is an index, not a substitute
for the complete [`manual change record`](./manual-change-record-template.md).

## Register fields

| Field | Required value |
|---|---|
| Change ID | Stable unique identifier matching the complete record |
| Title | Short, non-sensitive description |
| Type | `normal` or `emergency` |
| Significant | `yes` or `no` with rationale in the full record |
| CDE impact | `none`, `possible`, or `in scope` |
| Target environment | Approved safe environment identifier |
| Release/configuration identity | Immutable release, artifact, SQL, or configuration hash/reference |
| Planned date | UTC date |
| Actual completion date | UTC date or `not deployed` |
| Status | `draft`, `approved`, `scheduled`, `deployed`, `recovered`, `failed`, `rejected`, `cancelled`, or `closed` |
| Change authority | Named identity or controlled identity reference |
| Complete record | Resolvable controlled reference |
| Approval evidence | Resolvable controlled reference or `pending` before approval |
| Post-change result | `passed`, `failed`, `recovered`, `not deployed`, or `pending` |
| Closure date | UTC date or `open` |
| Incident/finding links | Controlled references or `none` |

## Register

Do not add illustrative or fake rows. Populate only from authentic change records.

| Change ID | Title | Type | Significant | CDE impact | Environment | Release/config identity | Planned date | Completed date | Status | Authority | Record reference | Approval reference | Post-change result | Closure date | Incident/finding links |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## Reconciliation record

- Review period: `<start and end dates>`
- Production release source reviewed: `<controlled reference>`
- Database/configuration change source reviewed: `<controlled reference>`
- Emergency/incident source reviewed: `<controlled reference>`
- Total source changes: `<count>`
- Total register entries: `<count>`
- Missing, duplicate, cancelled, failed, or recovered changes reconciled: `<details and references>`
- Reconciler: `<named identity>`
- Independent reviewer: `<named identity or approved accountability rationale>`
- Completed (UTC): `<YYYY-MM-DDThh:mm:ssZ>`
- Approval reference: `<controlled reference>`

## Acceptance test

The register is operating evidence only when the approved owner can reconcile it
to the full production-change population for the sampled period, every entry
links to an authentic complete record, and an assessor can select applicable
normal, emergency, failed, recovered, and significant changes without relying on
verbal explanation. Categories with no events need reconciled zero-count evidence;
an emergency-free period also needs an approved tabletop/process test.
