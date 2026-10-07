# Demo knowledge base: Larkspur Cloud

A synthetic support knowledge base for the public Truenote demo. Larkspur Cloud is a fictional cloud-storage subscription company with Basic, Pro and Enterprise plans. Every name, price, phone number and policy is invented.

The set covers every format the upload route accepts (PDF, DOCX, PNG, JPEG, WEBP, Markdown and plain text), so one upload pass exercises each parser path: PDF text extraction, OCR of a scan with no text layer, DOCX conversion, screenshots, AI-generated images and plain text.

## Files

All upload-ready files are in `files/`.

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

Upload them all into the same program. The documents agree with each other; where one refers to another (for example the refund procedure and the reason codes in the billing screenshot), the facts match.

## Key facts

These are the answers a CSR should get, with the file that holds each one. Several facts appear in more than one file, which is deliberate.

- Cancellation fee after 30 days: Basic $5, Pro $10, Enterprise $25 (`cancellation-policy.pdf`).
- No cancellation fee for customers who signed up before January 1, 2022, or for customers in California or New York (`cancellation-policy.pdf`).
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
- Support is closed on Thu Nov 26, Fri Dec 25 and Fri Jan 1; the outage line 1-800-555-0142 stays open 24/7 (`holiday-support-hours.png`, `outage-and-service-credits-faq.md`).

## Eval questions

The 10 existing eval questions stay answerable from this set: their facts ($5 and $10 fees, the legacy and California/New York exemptions, 5-7 business days, the Tier 2 supervisor, the 30-day window, the refund and cancellation steps) are unchanged, and the out-of-scope "moon-rocket plan" question still has no answer here.

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

1. Sign in to Truenote as a super user or senior manager. Their uploads activate as soon as parsing finishes; a manager's upload waits for approval. The public demo accounts cannot upload, because demo mode blocks writes.
2. Upload every file in `files/` to the demo program from the admin documents page, choosing the existing approved content source, and wait until each one shows as ready. The external malware scan is turned off in the demo's Security settings, so uploads are not quarantined for lack of a scanner.
3. Open each of the two older demo documents ("Cancellation Policy v4" and "Refund Procedure v4") and choose **Revoke now**, so citations point at the new set. Their original files were never copied to Railway, so they can be read but not rescanned. Revoking is safe for the eval on the Railway demo: none of its 10 eval questions has an expected document bound (`expected_doc_id` is empty on all of them, checked 2026-10-07), so citation scoring does not look for the old documents. On a database seeded with `scripts/src/seed.ts`, which binds `expected_doc_id` to the seeded documents, point those questions at the new documents before revoking, or their citation checks fail even when the answer is right.
4. Ask one question per format from the table above and check that each answer cites the expected file.

## Rebuilding the files

The PDFs, DOCX files, the two screenshots and the scanned memo are generated from `source/`:

```bash
node docs/demo-kb/source/build.mjs
```

This needs Google Chrome (set `CHROME_PATH` if it is not in the default location) and Python with `python-docx` and `Pillow`, run through the `py` launcher.

The two AI images are not rebuilt by the script. They were generated once with the Codex image tool (`codex-image-gen` skill) on 2026-10-07, checked letter by letter against the text below, and converted with Pillow:

- `escalation-path-poster.webp`: a flat poster titled "Escalation Path" with four boxes (Tier 1 Agent, Tier 2 Supervisor, Billing Operations, Legal and Privacy), their one-line duties, and the footer "Escalate within 15 minutes if the customer asks for a supervisor."
- `holiday-support-hours.png`: a printed notice on a cork board, "Holiday Support Hours 2026", six date rows and the outage-line footer listed under Key facts.

If either image is regenerated, check every word and number before committing it: image models misspell text.
