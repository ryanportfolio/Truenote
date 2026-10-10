# Demo knowledge base: Cloudshelf

A synthetic support knowledge base for the public demo. Cloudshelf is a fictional cloud-storage subscription company with Basic, Pro and Enterprise plans. Every price, number and policy is invented.

The documents carry no person names, place names, email addresses or phone numbers, so OpenRouter's sensitive-info guardrail (Presidio person, location, email, phone, card, social security and IP address entities) has nothing to flag. Storage sizes are spelled out as gigabytes, because Presidio tags the two-letter abbreviation as a place. Keep it that way when editing: run a Presidio scan over `files/` and `source/` before committing.

The set covers every format the upload route accepts (PDF, DOCX, PNG, JPEG, WEBP, Markdown and plain text), so one upload pass exercises each parser path: PDF text extraction, OCR of a scan with no text layer, DOCX conversion, screenshots, AI-generated images and plain text.

## Files

All upload-ready files are in `files/`. The first 13 rows are the original format set; the 15 Markdown files after them were added on 2026-10-08 for the source library showcase (`scripts/src/seed-showcase.ts`).

| File | Format | What it exercises |
|---|---|---|
| `cancellation-policy.pdf` | PDF | Fee table, exceptions, numbered steps |
| `plans-and-pricing.pdf` | PDF, 2 pages | Wide tables, content split across a page break |
| `privacy-requests.pdf` | PDF | Stage table, warning callout |
| `pin-change-memo-scan.pdf` | PDF, image only | A scanned memo with a stamp and signature; no text layer, so it must be OCR'd |
| `refund-procedure.docx` | DOCX | Numbered procedure, reason-code table |
| `identity-verification.docx` | DOCX | Factor table, "never ask for" list |
| `billing-console-refund.png` | PNG | Screenshot of an internal billing tool with a refund form |
| `payment-decline-codes.jpg` | JPEG | Screenshot of a reference table |
| `escalation-path-poster.webp` | WEBP | AI-generated poster (flow diagram) |
| `holiday-support-hours.png` | PNG | AI-generated photo of a printed notice on a cork board |
| `escalation-matrix.md` | Markdown | Routing table plus rules |
| `outage-and-service-credits-faq.md` | Markdown | Question-and-answer format with a credit table |
| `call-scripts.txt` | Plain text | Required lines and guidance |
| `updating-a-payment-method.md` | Markdown | Payment methods table, decline handling, grace period |
| `plan-upgrades-and-proration.md` | Markdown | Worked proration examples, billing-term switches |
| `enterprise-seat-management.md` | Markdown | Administrator-only changes, seat pricing table |
| `storage-limits-and-overage.md` | Markdown | Usage thresholds, no overage charges |
| `two-factor-authentication-reset.md` | Markdown | Higher verification bar, 24-hour waiting period |
| `account-recovery-lost-email.md` | Markdown | PIN-required email change, 72-hour hold |
| `password-reset-and-account-unlock.md` | Markdown | Lockout rules, reset link lifetime, script |
| `data-export-requests.md` | Markdown | Export contents table, link timing |
| `retention-offers-and-save-script.md` | Markdown | Offer table by cancel reason, script lines |
| `chargeback-and-dispute-intake.md` | Markdown | Dispute versus chargeback, BILL-CB intake |
| `invoices-and-tax-receipts.md` | Markdown | Invoice detail changes, sales tax |
| `education-and-nonprofit-discounts.md` | Markdown | Eligibility table, discounted prices |
| `accessibility-and-relay-calls.md` | Markdown | Relay call etiquette, accommodations table |
| `deceased-account-holder-requests.md` | Markdown | Request table by caller, LP-PRIV ticket |
| `fraud-team-handoff.md` | Markdown | Written as a confidential procedure. Uploaded as `internal` on 2026-10-08, because the agent account's clearance is `internal` and the upload route refuses content above the uploader's clearance. Re-upload it as `confidential` from an account with that clearance to show it as a restricted source to CSRs |

Upload them all into the same program. The documents agree with each other; where one refers to another (for example the refund procedure and the reason codes in the billing screenshot), the facts match.

## Key facts

These are the answers a CSR should get, with the file that holds each one. Several facts appear in more than one file, which is deliberate.

- Cancellation fee after 30 days: Basic $5, Pro $10, Enterprise $25 (`cancellation-policy.pdf`).
- No cancellation fee for customers who signed up before January 1, 2022, or for customers who cancel within 14 days of a price-increase notice (`cancellation-policy.pdf`, `retention-offers-and-save-script.md`).
- Refund window: 30 days from the charge date. Refunds post to the original card within 5-7 business days (`refund-procedure.docx`, `billing-console-refund.png`).
- A Tier 2 supervisor must approve any courtesy refund; reason code RF-05 (`refund-procedure.docx`, `billing-console-refund.png`, `escalation-path-poster.webp`).
- Prices: Basic $4.99 a month, Pro $11.99 a month or $119 a year, Enterprise $24 per user a month with 5 users minimum (`plans-and-pricing.pdf`).
- Downgrades take effect at the next renewal, with no partial refund (`plans-and-pricing.pdf`).
- Identity verification needs two factors; never ask for the full card number, the CVV or the password (`identity-verification.docx`, `call-scripts.txt`).
- Account PINs have 6 digits since October 1, 2026; 4-digit PINs no longer verify (`pin-change-memo-scan.pdf`, `identity-verification.docx`).
- Decline code D41 means a lost or stolen card: never retry it and do not tell the customer why (`payment-decline-codes.jpg`).
- After a failed renewal the system retries 3 times over 7 days, then the account becomes read-only (`payment-decline-codes.jpg`).
- Enterprise uptime commitment 99.9% a month; credit 10% below 99.9% and 25% below 99.0%; claim within 30 days (`outage-and-service-credits-faq.md`).
- Escalate within 15 minutes when a customer asks for a supervisor (`escalation-matrix.md`, `escalation-path-poster.webp`, `call-scripts.txt`).
- Deletion: 30-day soft delete, permanent on day 31; export link within 30 days, usually 3 business days (`privacy-requests.pdf`).
- Support is closed on Thu Nov 26, Fri Dec 25 and Fri Jan 1; the outage line, extension 4400, stays open 24/7 (`holiday-support-hours.png`, `outage-and-service-credits-faq.md`).
- Card details are entered only by the customer in Billing settings; PayPal works on Basic and Pro, invoice billing only on Enterprise annual plans (`updating-a-payment-method.md`).
- Upgrades are prorated by day; example: Basic to Pro with 15 of 30 days left costs $3.50 (`plan-upgrades-and-proration.md`).
- Only the Enterprise account administrator changes seats; added seats are prorated, removed seats take effect at renewal, never below 5 users (`enterprise-seat-management.md`).
- There are no storage overage charges or add-on storage; uploads pause at 100% and a warning goes out at 90% (`storage-limits-and-overage.md`).
- A sign-in 2FA reset needs the PIN or the email code as one factor and has a 24-hour waiting period; customers get 10 backup codes (`two-factor-authentication-reset.md`).
- Changing a lost account email needs the 6-digit PIN plus one more factor and has a 72-hour hold (`account-recovery-lost-email.md`).
- Accounts lock for 30 minutes after 10 failed sign-ins; reset links last 60 minutes (`password-reset-and-account-unlock.md`).
- Only one open export request per account; files come as ZIP archives, account data as JSON (`data-export-requests.md`).
- Retention: one offer per call, no discounts; Basic and Pro can pause for 1 to 3 months once in 12 months (`retention-offers-and-save-script.md`).
- Never refund a charge already in a chargeback; chargebacks go to Billing Operations, queue BILL-CB, 1 business day (`chargeback-and-dispute-intake.md`).
- Invoices from the past 7 years are under Billing settings; tax IDs apply to future invoices only (`invoices-and-tax-receipts.md`).
- Education and nonprofit discount: 30% off Pro and Enterprise (Pro monthly $8.39); students and teachers qualify for Pro; reviewed within 2 business days (`education-and-nonprofit-discounts.md`).
- On relay calls, speak to the customer, not the operator, and verify with the same two factors (`accessibility-and-relay-calls.md`).
- Bereavement: billing is paused the same day; account closure goes to Legal and Privacy, queue LP-PRIV, with no cancellation fee (`deceased-account-holder-requests.md`).
- Suspected takeover or card testing is P1: lock the account and page Security Response, who respond within 1 hour (`fraud-team-handoff.md`).

## Eval questions

Nine of the 10 existing eval questions stay answerable from this set: their facts ($5 and $10 fees, the legacy exemption, 5-7 business days, the Tier 2 supervisor, the 30-day window, the refund and cancellation steps) are unchanged, and the out-of-scope "moon-rocket plan" question still has no answer here. The state-law exemption was removed, so the tenth eval question "What state laws override the standard cancellation policy?" no longer has an answer. It is replaced by "Which customers besides legacy customers pay no cancellation fee?", whose expected answer contains "price-increase" and "14 days".

Suggested additions, one per format, so the eval covers each parser path:

| Question | Expected answer contains | Source |
|---|---|---|
| What is the monthly price of the Pro plan? | $11.99 | PDF |
| How many digits does an account PIN need? | 6 | Scanned PDF (OCR) |
| Which reason code is used for a courtesy refund? | RF-05 | DOCX and PNG |
| What should I tell a customer whose card returns decline code D41? | different card | JPEG |
| Who handles chargebacks? | Billing Operations | WEBP |
| Is support open on December 25? | Closed | PNG photo |
| What credit does an Enterprise customer get if uptime falls below 99.0%? | 25% | Markdown |
| What must I say when I open a call? | recorded | Plain text |
| What is the cancellation fee for the Platinum plan? | refusal (no Platinum plan exists) | none |

## Uploading

1. Sign in to the app as a super user or senior manager. Their uploads activate as soon as parsing finishes; a manager's upload waits for approval. The public demo accounts cannot upload, because demo mode blocks writes.
2. Upload every file in `files/` to the demo program from the admin documents page, choosing the existing approved content source, and wait until each one shows as ready. The external malware scan is turned off in the demo's Security settings, so uploads are not quarantined for lack of a scanner.
3. Open each of the two older demo documents ("Cancellation Policy v4" and "Refund Procedure v4") and choose **Revoke now**, so citations point at the new set. Their original files were never copied to Railway, so they can be read but not rescanned. Revoking is safe for the eval on the Railway demo: none of its 10 eval questions has an expected document bound (`expected_doc_id` is empty on all of them, checked 2026-10-07), so citation scoring does not look for the old documents. On a database seeded with `scripts/src/seed.ts`, which binds `expected_doc_id` to the seeded documents, point those questions at the new documents before revoking, or their citation checks fail even when the answer is right.
4. Ask one question per format from the table above and check that each answer cites the expected file.

## Showcase seed

`scripts/src/seed-showcase.ts` uploads the 15 showcase files and fills the source library and Source usage pages with demo activity: six seeded CSR accounts (one of them asks nothing), nested folders, tags, team pins, about 200 real questions with thumbs up and down, reader opens, personal shortcuts, notes and colors, and a backdate step that spreads the activity over 90 days. Its header lists each step, what it needs and which steps add rows on a re-run. It ran once against the Railway demo on 2026-10-08. The seeded CSR accounts keep their `larkspur.example` sign-in emails from before the company rename; those are user accounts, not document text.

## Rebuilding the files

The PDFs, DOCX files, the two screenshots and the scanned memo are generated from `source/`:

```bash
node docs/demo-kb/source/build.mjs
```

This needs Google Chrome (set `CHROME_PATH` if it is not in the default location) and Python with `python-docx` and `Pillow`, run through the `py` launcher.

The two AI images are not rebuilt by the script. They were generated once with the Codex image tool (`codex-image-gen` skill) on 2026-10-07, checked letter by letter against the text below, and converted with Pillow:

- `escalation-path-poster.webp`: a flat poster with the header "Cloudshelf", titled "Escalation Path", with four boxes (Tier 1 Agent, Tier 2 Supervisor, Billing Operations, Legal and Privacy), their one-line duties, and the footer "Escalate within 15 minutes if the customer asks for a supervisor."
- `holiday-support-hours.png`: a printed notice on a cork board, "Holiday Support Hours 2026", six date rows and the footer "Outage line stays open 24/7: extension 4400".

On 2026-10-10 the company name in the poster header and the outage-line footer of the notice were redrawn in place with Pillow (Segoe UI Bold and Arial Bold from `C:\Windows\Fonts`, matched to the original size and color), replacing the old company name and a phone number. If either image is regenerated, check every word and number before committing it: image models misspell text.
