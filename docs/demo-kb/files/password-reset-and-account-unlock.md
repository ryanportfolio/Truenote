# Password Reset and Account Unlock

Larkspur Cloud Customer Support · Procedure CS-PRO-021 · Version 5 · Effective September 1, 2026 · Owner: Security Response

## When to use this

Use this procedure when a customer forgot their password, did not receive the reset email, or is locked out after too many failed sign-in attempts.

## The rules

- Agents never set, read out or ask for a password. The customer always chooses their own password on their own screen.
- An account locks for 30 minutes after 10 failed sign-in attempts in a row. The lock clears on its own.
- A password reset link is valid for 60 minutes and works once.
- Passwords must be at least 12 characters.

## Steps for a forgotten password

1. You do not need to verify the caller just to explain how to reset a password.
2. Ask the customer to open the sign-in page and select Forgot password.
3. They enter the account email. The reset email arrives within 5 minutes.
4. They open the link within 60 minutes and choose a new password.
5. Every other signed-in device is signed out after the reset. Tell the customer to expect that.

## If the reset email does not arrive

1. Ask the customer to check spam and any filters, and to wait the full 5 minutes.
2. Verify the caller with two factors before you look at the account.
3. Confirm the email on the account matches the one they typed. Read only the first letter and the domain (for example, "j at example dot com"); never read the full address to an unverified caller.
4. If it matches, select Resend reset email in the admin tools. Requests are limited to 5 per hour per account.
5. If the customer no longer has access to that mailbox, switch to Account Recovery When the Email Is Lost.

## Steps to unlock an account early

1. Verify the caller with two factors.
2. In the admin tools, open Security and select Unlock account.
3. Suggest a password reset if they are unsure of the password, so they do not lock it again.
4. Add an account note with the reason.

## Reference

| Situation | What to do | Verification needed |
|---|---|---|
| Forgot password | Self-service Forgot password link | No |
| Reset email missing | Check address, resend from admin tools | Two factors |
| Locked after 10 failed attempts | Wait 30 minutes, or unlock early | Two factors to unlock early |
| No access to the account email | Account Recovery When the Email Is Lost | PIN plus one more factor |
| Enterprise organization with SSO | Send the user to their company IT team | Not applicable |
| Verification fails twice | Read the failed-verification line, end account-specific discussion | Not applicable |

## Script

When the caller fails verification twice, read this line from the Call Scripts word for word: "I'm not able to verify the account over the phone right now. You can recover access from the sign-in page using 'Forgot password', or reply to the email we just sent."

## Watch for takeover signs

Repeated lockouts from different locations, a caller asking for the password to be read to them, or a caller who wants a reset link sent to a new address are warning signs. Do not send links to new addresses. If you suspect an account takeover, lock the account and escalate to Security Response within 1 hour.

Synthetic document for the Truenote demonstration. Larkspur Cloud is a fictional company; all names and numbers are invented.
