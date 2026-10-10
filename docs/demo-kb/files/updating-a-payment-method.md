# Updating a Payment Method

Cloudshelf Customer Support · Procedure CS-PRO-011 · Version 3 · Effective September 1, 2026 · Owner: Billing Operations

## When to use this

Use this procedure when a customer wants to change the card on file, add a second card, or fix a renewal that failed because the card expired or was declined. Card details are always entered by the customer in Billing settings. Agents never type, read back or store card numbers.

## Before you start

Verify the caller with two factors (see the Identity Verification procedure). The last 4 digits of the card on file count as one factor; the full card number and the security code never do.

If the customer starts to read a card number aloud, stop them with the line from the Call Scripts: "Please don't read your card number to me. You can update it safely in Billing settings, and I'll stay on the line while you do."

## Steps

1. Ask the customer to sign in and open Billing settings, then Payment methods.
2. Have them select Add card and enter the new card details on their own screen.
3. Ask them to choose Make default on the new card.
4. If the account has a failed renewal, ask them to select Retry payment now. The charge runs within a few minutes.
5. Confirm in the billing console that the new card shows as default (you will see only the brand and the last 4 digits).
6. Add an account note: reason for the call, the card brand and last 4 digits now on file, and whether a retry succeeded.

The customer can remove an old card only after another card is set as the default. An account always keeps one default card while a paid plan is active.

## Accepted payment methods

| Method | Basic | Pro | Enterprise |
|---|---|---|---|
| Visa, Mastercard, American Express, Discover | Yes | Yes | Yes |
| PayPal | Yes | Yes | No |
| Invoice paid by bank transfer (ACH or wire) | No | No | Annual plans only |
| Prepaid or gift cards | No | No | No |

Enterprise customers who want to move to invoice billing need the account administrator to open a ticket with Billing Operations. Agents cannot switch an account to invoice billing.

## If the new card is declined

Look up the decline code in the Payment Decline Codes quick reference and read the matching customer line. Two codes need extra care:

- D41 (card reported lost or stolen): say only "This card can't be used. Please add a different card." Never retry it and never mention lost or stolen.
- D91 (card issuer unavailable): the system retries automatically after 1 hour. The customer does not need to do anything.

## Failed renewals and the grace period

After a failed renewal the system retries 3 times over 7 days. If every retry fails, the account becomes read-only: the customer can view and download files but cannot upload or share. Updating the card and selecting Retry payment now restores full access as soon as the charge clears. Files are never deleted because of a failed payment alone.

## What not to do

- Do not take card details over the phone, by chat or by email, even if the customer insists.
- Do not promise that a declined card will work on a second try.
- Do not waive or refund a renewal charge because the card was updated late. Courtesy refunds need a Tier 2 supervisor.

Synthetic demonstration document. Cloudshelf is a fictional company; all policies and numbers are invented.
