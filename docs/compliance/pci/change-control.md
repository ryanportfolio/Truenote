# Secure change control

**Status:** Draft for Engineering, Security, and PCI approval

**Owner:** Change authority - unassigned

**Artifact evidence grade:** Operational evidence required

**Current Requirement 6.5 control grade:** Gap

This procedure applies to production application, dependency, configuration,
provider, database, identity, logging, network, and security-control changes that
can affect Truenote or a connected Cardholder Data Environment (CDE).

It is tool-neutral. The approved record may live in the organization's existing
change-management system, a controlled document repository, or another retained
system of record. A GitHub pull request may support the record, but GitHub branch
protection, CODEOWNERS, or a passing workflow is not required by this procedure.

Normative basis: PCI DSS v4.0.1 Requirement 6.5. The PCI SSC
[document library](https://www.pcisecuritystandards.org/document_library/?class=pcidss&doc=pci_dss)
was checked on 2026-07-17. The QSA or compliance-accepting entity determines
applicability and evidence sufficiency.

## Records

Use:

- [`manual-change-record-template.md`](./manual-change-record-template.md) for
  each normal or emergency change; and
- [`change-register-template.md`](./change-register-template.md) to identify the
  complete population from which an assessor can sample changes.

The record identifier must be stable and unique. Supporting artifacts may remain
in restricted systems, but the record must identify their controlled references.
Do not place credentials, PAN, customer data, production exports, or detailed
unremediated exploit material in repository evidence.

## Normal change process

1. **Open the record.** State the reason, description, requester, affected
   components, environments, data paths, intended date, and system of record.
2. **Assess impact.** Record security impact, CDE impact, whether the change is
   significant, applicable threats, dependencies, and required PCI controls.
   `Not yet determined` blocks approval.
3. **Plan verification and recovery.** Define functional and negative security
   tests, Requirement 6.2.4 testing for bespoke/custom software, the failure
   signal, and the procedure to return to a secure state.
4. **Review before production.** An authorized party approves or rejects the
   change. Bespoke/custom software changes receive review by a knowledgeable
   person other than the originating author, as required by Requirement 6.2.3.
   Missing non-author review remains a gap and is not waived by a small-team
   accountability model.
5. **Deploy under authority.** Record the executor, authorization reference,
   target environment, actual start/end time, release or configuration identity,
   and result.
6. **Verify after deployment.** Retain the planned production checks and confirm
   the system is secure. Failed checks trigger the documented recovery procedure
   or an approved forward repair.
7. **Close the record.** Resolve findings and follow-up actions, confirm test
   data/accounts were removed, complete significant-change revalidation, update
   affected documentation, and obtain closure approval.
8. **Update the register.** The register entry must link to the complete record
   and show its final state. Draft, rejected, failed, recovered, and cancelled
   changes remain visible; they are not deleted from the population.

## Significant change decision

The change authority records `yes` or `no` with a rationale. At minimum, assess
the PCI SSC [significant-change examples](https://www.pcisecuritystandards.org/faqs/1317/):

- new hardware, software, or network equipment added to the CDE;
- replacement or major upgrade of CDE hardware or software;
- change to account-data flow or storage;
- change to the CDE boundary or PCI assessment scope;
- change to supporting infrastructure such as identity, time, logging, or
  monitoring; and
- change to a third-party provider or service that supports the CDE or performs a
  PCI requirement.

After a significant change, all applicable PCI DSS requirements must be confirmed
in place on the new or changed systems and networks. Update procedures, diagrams,
inventories, responsibility records, and annual scope-confirmation inputs as
applicable. A planned check does not close this requirement.

## PCI DSS 6.5 control coverage

### 6.5.1 Production change procedures

Every production change records reason and description, security impact,
authorized approval, security testing, applicable Requirement 6.2.4 testing for
bespoke/custom software, and a secure recovery procedure.

### 6.5.2 Significant-change completion

The record identifies significance. Applicable PCI DSS requirements and affected
documentation are revalidated after completion before the record closes.

### 6.5.3 Pre-production separation

Record the environments used for development and testing and the evidence that
access controls separate them from production. A non-applicability decision needs
a named owner and written approval.

### 6.5.4 Roles and functions

Record requester, developer, tester, reviewer, deployer, and change authority.
Where one person performs multiple pre-production or production roles, document
the approved accountability model, additional controls, and production-access
controls. Do not imply separation that does not exist. This accountability model
does not replace Requirement 6.2.3 non-author review of bespoke/custom software.

### 6.5.5 Live PAN in pre-production

Synthetic data is the default. Record whether live PAN was used. Any exception
requires prior authorization, defined scope, applicable PCI DSS protection, and
retained evidence.

### 6.5.6 Test data and accounts

Remove test data and accounts from production components before closure. Record
the owner, result, date, and verification reference.

## Database and configuration changes

- Retain exact reviewed SQL or configuration bytes and their hash.
- Record executor, authority, target environment, release/configuration identity,
  result, production verification, and recovery procedure.
- A successful development execution or deployment action does not prove the
  production definition or state.
- Use the read-only production verification procedure where applicable.

## Emergency changes

An emergency change requires an incident or urgent-risk identifier, named
emergency authority, minimum necessary scope, recovery decision, and immediate
validation. Complete the normal record, full testing evidence, and retrospective
review under the approved emergency-change deadline. The draft operating target
is within two business days; this target is organization-chosen and not stated as
a PCI DSS-prescribed frequency. Emergency status does not waive unresolved CDE
scope or evidence.

## Evidence retention and review

- Retain the register, complete records, approvals, test results, release identity,
  recovery evidence, and post-change results under the organization's PCI evidence
  retention policy.
- Reconcile the register to production releases, database/configuration changes,
  emergency records, and incidents at the approved cadence and before an
  assessment sample is selected. The draft operating target is at least
  quarterly; this target is organization-chosen and not a PCI DSS-prescribed
  frequency.
- Review this procedure and role assignments at least annually and after a major
  process, CDE, provider, or organizational change.

## Current limitation

This procedure and its templates are prepared but not adopted. The change
authority is unassigned, no approved system of record or retention period is
identified here, and no completed normal production sample has been reviewed.
Emergency evidence is also missing: either an authentic sample if an emergency
occurred in the review period, or reconciled zero-event evidence plus an approved
tabletop if none occurred. Requirement 6.5 therefore remains a **Gap**. Advanced
GitHub branch evidence is owner-deferred and is not part of the current acceptance
test.

## Binary acceptance test

Requirement 6.5 process evidence is ready for assessment only when all are true:

1. an authorized owner approved this procedure and named the system of record;
2. the register reconciles to the complete production-change population for the
   sampled period;
3. one sampled normal production change has a complete, truthful record with
   6.5.1 through 6.5.6 decisions, authorization, security tests, secure recovery,
   deployment identity, post-change verification, and closure;
4. emergency handling is evidenced by either a sampled emergency change, when one
   occurred in the reconciled period, or reconciled zero-emergency evidence plus
   an approved tabletop/process test when none occurred;
5. every controlled reference resolves to authentic evidence and every open
   finding has an owner, due date, disposition, and retest or exception path; and
6. the assessor can trace each sample from register entry to approval, exact
   change, test evidence, production result, recovery outcome, and closure without
   relying on verbal explanation.
