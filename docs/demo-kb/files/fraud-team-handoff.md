# Fraud Team Handoff

Larkspur Cloud Customer Support · Procedure CS-PRO-030 · Version 3 · Effective October 1, 2026 · Owner: Security Response · Classification: Confidential

## When to use this

Use this procedure when you suspect fraud on a call or an account: an account takeover, stolen card use, card testing, or a caller trying to get information they should not have. This document is confidential. Do not read it to customers, share it outside Support, or describe the signals below to a caller.

## Signals that mean hand off now

| Signal | Example | Priority |
|---|---|---|
| Takeover attempt | Caller cannot verify but wants the account email changed or two-factor authentication turned off | P1 |
| Stolen card | Payment returns decline code D41 | P2 |
| Card testing | Three or more cards added and declined on one account in 24 hours | P1 |
| Social engineering | Caller claims to be from Larkspur, a bank or the police and asks for account details | P1 |
| Linked accounts | Several new accounts share one card or one billing ZIP and phone number | P2 |
| Repeated failures | Verification failed twice on two different calls in one day | P2 |

P1: lock the account and page Security Response; they respond within 1 hour. P2: open a ticket in queue SEC-FRD; Security Response reviews it within 1 business day.

## Steps for a P1 handoff

1. Stay calm and do not accuse the caller. Do not say the word fraud.
2. Stop all account-specific discussion. Use the failed-verification line from the Call Scripts if needed.
3. In the admin tools, open Security and select Lock account, reason "Suspected takeover". The lock signs out every session and blocks password resets.
4. Page Security Response from the admin tools (Security, then Page Security Response). Include the account email, what the caller asked for, and the time of the call.
5. End the call politely: "For your security I'm not able to make changes to this account right now. The account holder will be contacted at the email on file."
6. Add an internal note marked Security. Do not write the reason in any note the customer can see.

## Steps for a P2 handoff

1. Finish the call normally where it is safe to do so.
2. Open a ticket in queue SEC-FRD with the account email, the signal and any decline codes.
3. Do not lock the account unless Security Response asks you to.

## Stolen cards (D41)

Never retry a card that returned D41. Never tell the customer the card was reported lost or stolen. Read only: "This card can't be used. Please add a different card." If the same account then adds a second card that also fails, treat it as card testing (P1).

## What not to tell the caller

- That the account is flagged, locked for fraud, or under review by Security Response.
- Which signal you noticed or which factor failed.
- Whether an account exists, when the caller is asking about someone else's account.

## Law enforcement and legal requests

Calls from police, courts or lawyers go to Legal and Privacy, not Security Response. Do not confirm the account exists; give legal@larkspur.example.

## After a handoff

Security Response contacts the account holder at the email on file. If that customer calls back, do not unlock the account yourself; warm transfer to the Security Response queue. Unlocking is done only by Security Response.

Synthetic document for the Truenote demonstration. Larkspur Cloud is a fictional company; all names and numbers are invented.
