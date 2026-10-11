---
title: Plan of action and milestones summary
description: How Truenote tracks its open security items, how they are rated and approved, and how many are open, without the item details.
updated: 2026-10-11
---

## What the plan is

The plan of action and milestones (POA&M) lists every weakness found in the self-assessment, the controls it affects, a rating, dated milestones and the evidence that will close it. It follows the FedRAMP POA&M column set, including original and adjusted risk ratings, vendor dependencies and deviation records. The detailed plan is available to authorized reviewers who sign in.

## How items are rated

- Each item is rated on its own risk (Low, Moderate, High, or Critical for scanner findings), not on the highest-impact control it touches.
- An adjusted rating records a mitigating factor. It stays pending until it is approved.
- The system owner approves Low and Moderate adjustments and risk acceptances as a non-independent approver. High and Critical ones go to the first customer's security reviewer.
- Items are not deleted. A closed item stays in the plan with its closure evidence, and every change to a milestone is logged.

## When items are due

Each item has a track:

| Track | Meaning | Open items |
| --- | --- | ---: |
| Do now | Done whatever the go-live date | 5 |
| Go-live | Done before the first real customer data enters production | 27 |
| Second customer | Done before a second customer's data is stored beside the first | 2 |
| Moderate | Needed for the full Moderate baseline; dated milestones after go-live | 19 |
| PCI-conditional | Needed only if a customer brings Truenote into PCI DSS scope | 3 |
| Total | | 56 |

Go-live is the day the first real customer data enters production. A pilot with real customer documents or real user accounts counts as go-live.

## Open items by rating

As of October 11, 2026:

| Rating | Original | With adjustments |
| --- | ---: | ---: |
| High (2 of them Critical) | 7 | 3 |
| Moderate | 16 | 15 |
| Low | 33 | 38 |

Four of the adjustments concern High items and wait for the security reviewer's approval.

## How it is kept current

The plan is updated at least monthly, and whenever a scan, assessment or incident finds something new. The monthly update, with the scan and audit summary, is offered to the first customer's security reviewer.
