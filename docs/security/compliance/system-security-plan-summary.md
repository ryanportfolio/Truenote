---
title: System security plan summary
description: What Truenote is, where it runs, how it is categorized, and how its controls map to the NIST SP 800-53 Rev. 5 Moderate baseline.
updated: 2026-10-11
---

## The system

Truenote is a retrieval-augmented knowledge assistant for call-center customer service representatives. Administrators upload procedures, policies and reference material for a program. Representatives ask questions during calls and get answers that cite the source passages, or an explicit refusal when the knowledge base does not support an answer.

Expected users at the first customer in the first 12 months: about 500 representatives, 30 team leads, 5 managers and 3 trainers.

## Boundary

| Part | What it is |
| --- | --- |
| Application | A web service (API and browser app) and a background worker for document processing and evaluation |
| Data | A PostgreSQL database with vector search, and object storage for uploaded files |
| Supporting services | A self-hosted malware scanner for uploads, and an encrypted weekly copy of the database, files and code kept at a second provider |
| Hosting | Railway, a cloud platform; one production environment |
| External services | AI model, embedding, reranking and document-parsing providers, an email provider, GitHub for source code and CI, and DNS |
| Sign-in | Customer users sign in through the customer's Microsoft Entra ID with multi-factor authentication; this is built and waits for the customer's configuration |

The detailed plan lists every component, data flow, provider and interconnection.

## Categorization

Moderate for confidentiality, integrity and availability (FIPS 199), accepted by the system owner on October 11, 2026.

## Control status

All 287 controls and enhancements of the Moderate baseline are mapped, each with a status, an owner, evidence and a remediation where needed.

| Status | Controls |
| --- | ---: |
| Implemented | 2 |
| Partially implemented | 167 |
| Shared with a provider (provider evidence not yet held) | 15 |
| Planned | 27 |
| Gap | 66 |
| Not applicable, with a written rationale | 10 |
| Total | 287 |

"Planned" includes the 18 policy and procedure controls, which take effect when the policy set is signed, and the sign-in controls that wait for the customer's identity provider. Every control that is not implemented or not applicable is covered by an item in the plan of action and milestones.

## Controls in operation

- Program scoping is enforced on the server: a user on one program cannot retrieve content from another.
- Every answer shown to a representative carries a clickable citation or is an explicit refusal.
- Local sign-in credentials are hashed with Argon2id; session and reset tokens are stored hashed; a nonce-based content security policy is enforced.
- The application connects to the database with a least-privilege role, and the security event log is append-only.
- Uploads are scanned by a self-hosted malware scanner. While scanning is enabled, a file that cannot be scanned is quarantined; switching scanning off is a recorded administrative exception that expires after 24 hours.
- Security alerts, a daily export of logs outside the hosting platform, and uptime checks are in operation.
- An encrypted copy of the database, files and code is made weekly at a second provider and checked weekly; a restore from it was tested on October 10, 2026.
- Production is deployed only from reviewed, CI-passed code, and each deployment is recorded.

## Governance

- The information security policy, 18 procedures and 643 organization-defined parameter values are written. The system owner accepted the recommended decisions on October 11, 2026; formal sign-off of the plan and the policy set is pending.
- The system owner approves Low and Moderate risk decisions as a non-independent approver. High and Critical risk acceptances go to the first customer's security reviewer.
- No independent assessment is planned (owner decision, October 11, 2026); that control is recorded as not met. An AI-focused security test, covering prompt injection and similar model-specific attacks, is planned.

## Where the detail lives

| Topic | Public summary | Detailed document |
| --- | --- | --- |
| System boundary and data flows | Overview | Full |
| Control implementation status | Counts | Control-by-control statements and evidence |
| Open weaknesses and remediation plans | Counts only | Plan of action and milestones |
| Assessment results | Not published | Full results |
