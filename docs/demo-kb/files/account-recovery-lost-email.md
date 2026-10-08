# Account Recovery When the Email Is Lost

Larkspur Cloud Customer Support · Procedure CS-PRO-020 · Version 2 · Effective October 1, 2026 · Owner: Security Response

## When to use this

Use this procedure when a customer can no longer reach the email address on their Larkspur Cloud account (a closed work address, a deleted personal account, a former employer's domain) and needs the account email changed so they can sign in or receive messages again.

Changing the account email is the most common step in an account takeover. Follow every step, in order, even when the caller is friendly and the story makes sense.

## What makes this different

The one-time code factor goes to the account email, so the customer cannot use it. That leaves three factors: the 6-digit account PIN, the billing ZIP code, and the last 4 digits of the card on file. The caller must pass two of them, and one must be the PIN.

## Steps

1. Ask for the email address on the account and find it in the admin tools.
2. Verify the caller with the account PIN plus either the billing ZIP code or the last 4 digits of the card on file. A 4-digit PIN does not count.
3. Ask for the new email address and read it back letter by letter.
4. In the admin tools, open Security, then Change account email, and enter the new address.
5. Explain the 72-hour hold: the change is scheduled, not immediate. A notice goes to the old address and a confirmation link goes to the new one.
6. The customer must open the confirmation link in the new mailbox. After 72 hours the change completes if nobody cancels it from the old address.
7. Add an account note: reason, factors used, old and new addresses.

## Reference

| Situation | Outcome |
|---|---|
| PIN plus ZIP or last 4 digits verified | Schedule the email change with a 72-hour hold |
| No PIN set, or the caller does not know it | Cannot change the email by phone; offer recovery by mailed letter (below) |
| Verification fails twice | End account-specific discussion; read the failed-verification line from the Call Scripts |
| Caller pushes to skip the hold | Do not skip it; escalate to a Tier 2 supervisor if they ask for one |
| Enterprise team member | The account administrator changes member emails in the admin console |
| Enterprise administrator | Requires a second administrator, or a letter on company letterhead to Security Response |

## Recovery by mailed letter

If the customer has no PIN, Security Response can mail a one-time recovery code to the billing address on file. The letter arrives in 5 to 10 business days. Submit the request in the admin tools under Security, then Mail recovery code. Agents cannot change the billing address on the same call.

## Signs of a takeover attempt

- The caller knows the card's last 4 digits but not the PIN, and wants the email changed today.
- The new email is a free address that looks unrelated to the customer's name.
- There have been sign-in alerts or password resets on the account in the past 48 hours.
- The caller asks you to turn off two-factor authentication at the same time.

If you see these signs, do not make the change. Lock the account and escalate to Security Response within 1 hour. Tell the caller that Security Response will contact the account holder.

## Never do this

- Never send account details, a code or a link to an address that is not already on the account. The one exception is the confirmation link the system itself sends to the new address in step 5, after verification.
- Never accept a Social Security number, a full card number or the account password as proof.
- Never confirm which factor was wrong.

Synthetic document for the Truenote demonstration. Larkspur Cloud is a fictional company; all names and numbers are invented.
