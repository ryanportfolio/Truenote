---
title: PCI DSS scope summary
description: Whether Truenote touches payment card data, when a customer's assessment may include it, and what Truenote has prepared.
updated: 2026-10-11
---

## Short answer

Truenote is not designed to store, process or transmit payment card data, and it has no network connection to any customer payment system. Card numbers are prohibited in Truenote by policy, which has no approved path for them, and customers will be told not to enter them.

Truenote is not automatically out of scope either. PCI DSS asks whether a system could affect the security of card data. Truenote runs beside the customer's CRM on the representative's desktop during live calls. If representatives take card payments by phone on that same desktop, the customer should plan as if Truenote is security-impacting and Truenote is a third-party service provider to them.

## Who decides

Scope is decided by each customer, its Qualified Security Assessor and its acquirer. Truenote supplies the analysis and evidence for that decision.

A customer can take the representative desktop out of scope by moving payment capture off it, for example with DTMF masking, an IVR or a pay-by-link flow. Whether that is commercially workable is the customer's choice.

## What Truenote has prepared

- A scope analysis covering six scenarios, including Truenote running on the same desktop as payment handling and the integrity of payment procedures stored in the knowledge base.
- A readiness self-assessment against SAQ D for Service Providers (PCI DSS v4.0.1, 260 requirements). It is a readiness record only: it is not signed and is not an Attestation of Compliance. Most requirements are not yet in place, and the work is tracked in the plan of action and milestones.
- A proposed split of responsibilities between Truenote and the customer.

The application screens questions and uploads for card numbers, but that check is a backstop, not a guarantee. The prohibition, user guidance and contract terms are the control.

The detailed analysis and readiness assessment are available to authorized reviewers who sign in.
