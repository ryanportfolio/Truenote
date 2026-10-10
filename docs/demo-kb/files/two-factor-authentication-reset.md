# Two-Factor Authentication Reset

Cloudshelf Customer Support · Procedure CS-PRO-019 · Version 4 · Effective October 1, 2026 · Owner: Security Response

## When to use this

Use this procedure when a customer has turned on two-factor authentication (2FA) for sign-in and can no longer complete it: a lost or replaced phone, a deleted authenticator app, or no backup codes left. Do not confuse sign-in 2FA with the two factors agents use to verify callers on the phone; they are separate.

## Self-service first

Every customer who turns on 2FA receives 10 single-use backup codes. Ask whether they still have them. A backup code signs them in, and they can then set up 2FA again under Security settings. If they have a code, walk them through this and stop here.

## Verification before a reset

A 2FA reset removes a security control, so the bar is higher than for an ordinary call:

1. Verify the caller with two factors from the Identity Verification procedure.
2. At least one factor must be the account PIN (6 digits) or the one-time code sent to the account email. Billing ZIP plus last 4 digits of the card is not enough on its own for a 2FA reset.
3. A 4-digit PIN is not a valid factor. 4-digit PINs stopped working on October 1, 2026.

If verification fails twice, stop account-specific discussion and point the caller to self-service recovery from the sign-in page. Do not hint which factor was wrong.

## Steps to reset 2FA

1. In the admin tools, open the account and select Security, then Reset two-factor.
2. Choose the reason from the list (lost device, new device, app removed).
3. Tell the customer the reset is not instant. There is a 24-hour waiting period, and a security alert goes to the account email immediately.
4. After 24 hours the customer can sign in with their password only and must set up 2FA again on that first sign-in.
5. Add an account note with the reason and the factors used to verify.

If the customer replies to the security alert saying they did not ask for the reset, the reset is cancelled automatically and Security Response is notified.

## Reference

| Situation | What to do | Waiting period |
|---|---|---|
| Customer has a backup code | Self-service sign-in, then set up 2FA again | None |
| Verified with PIN or email code | Reset two-factor in admin tools | 24 hours |
| Cannot verify, wants the account email changed | Treat as suspected takeover | Lock the account; Security Response within 1 hour |
| Enterprise user | Send to their account administrator, who resets 2FA in the admin console | Set by the administrator |
| Enterprise organization that requires SSO | Send to the company's IT team; Cloudshelf 2FA is not used | Not applicable |

## Never do this

- Never turn off 2FA without the waiting period, even for a supervisor or a customer who says it is urgent.
- Never read a backup code, a one-time code or a password to the caller.
- Never accept the full card number, the CVV or a Social Security number as proof of identity.

## Suspected account takeover

Signs include a caller who cannot verify but wants to change the account email or turn off 2FA, several reset requests in one day, or a customer who reports sign-in alerts they did not cause. Lock the account and escalate to Security Response within 1 hour. Tell the customer that Security Response will contact them at the email on file.

Synthetic demonstration document. Cloudshelf is a fictional company; all policies and numbers are invented.
