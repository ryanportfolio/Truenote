# SSO with MFA for customer users: options and plan

Status: proposal for the owner's decision, October 9, 2026. No production setting, Railway variable or provider account was touched. The WorkOS API key was not used. Update, October 10: the code parts of steps 1, 2, 3a, 4, 5 and 6 merged in ryanportfolio/Truenote#226 (direct Entra, no WorkOS, passkey plus recovery codes for the emergency login); nothing is configured or deployed yet. Later on October 10 the owner chose `prompt=login` for idle re-authentication (decision 3), and its code is built (see "Sessions"); it is not deployed. The step 2 SSO invitation email is built in ryanportfolio/Truenote#239, and forgot-password and the admin password reset refuse SSO-only accounts in ryanportfolio/Truenote#240 (neither deployed). The "What the existing code does" section describes `main` before that build.

Scope: how call-center CSRs, supervisors and managers sign in to Truenote through their company's identity provider with MFA, how the single emergency super_user signs in, and what has to be true before the first real customer data enters production (go-live, no date set).

## Recommendation

Build on the existing OIDC code and connect directly to Microsoft Entra ID for the first customers, starting with the owner's employer, whose IT team registers Truenote in its own Entra tenant. Keep WorkOS as the planned route for the first customer that needs SAML, Okta or another non-Entra provider, and design the connection layer so a WorkOS connection can be added without reworking accounts or sessions.

The deciding reason is MFA evidence. With Entra's `amr` optional claim turned on, Truenote can check on every login that the user completed MFA and refuse the login if not. WorkOS's SSO profile has no documented MFA field, so with WorkOS Truenote would rely on each customer's written statement that their IdP enforces MFA. Direct Entra also keeps identity data out of an additional US-hosted processor and reuses code that already exists. Cost is not the deciding reason: WorkOS charges nothing until the first production connection.

This is the wrong call if the first serious prospect needs SAML or Okta, or if prospects' security reviews accept "the customer's IdP enforces MFA" without app-side evidence. In either case, start with WorkOS and keep direct Entra for tenants where Truenote must check MFA itself.

## Comparison

| | Direct Entra OIDC (existing code) | WorkOS SSO API | WorkOS AuthKit |
|---|---|---|---|
| Identity providers | Entra ID only, as planned. The OIDC client is generic, so Okta OIDC is possible later with per-provider testing | Any SAML or OIDC provider | Same as SSO API, plus its own password and social login |
| MFA evidence Truenote can check | `amr` contains `mfa` in the ID token after the optional claim is added | None documented. `raw_attributes` stopped returning data on 2026-04-15; custom attributes may be mappable for SAML (unconfirmed) | AuthKit's own TOTP MFA does not apply to SSO users |
| Customer IT setup | Admin consent link plus a Conditional Access policy, guided by a Truenote runbook | Self-serve Admin Portal link, including DNS domain verification | Same as SSO API |
| Joiner and leaver | Invitations now; SCIM endpoint to build later | Directory Sync (SCIM) delivered by signed webhooks | Same, and deprovisioning revokes AuthKit sessions |
| Price | $0. Customers need Entra ID P1 for Conditional Access and group assignment | $125 per SSO connection and $125 per Directory Sync connection at 1-15 connections, falling to $65 at 51-100. The page did not show a time unit; WorkOS markets it as monthly, confirm before budgeting. Staging is free | Free to 1M monthly active users, but SSO connections are billed as above |
| Data the vendor receives | None beyond Microsoft | Profile (email, names, IdP id, role, custom attributes), directory users and groups | All of that plus sessions and user records |
| Assurance | Microsoft's own | SOC 2 Type 2, GDPR, CCPA; HIPAA BAA on enterprise plan; US data residency; no ISO 27001 or FedRAMP found | Same |
| Fit with current code | Small changes to `lib/auth/oidc.ts` and `routes/oidc.ts` | New adapter using `@workos-inc/node`; WorkOS SSO has no OIDC discovery document, so the generic client cannot point at it | Replaces parts of Truenote's user and session model; largest change |

AuthKit is the product the owner referred to as "authmd" (confirmed October 9). Its value is a hosted login and user store, which Truenote already has. It does not help with MFA for SSO users, so it is not recommended.

Other brokers seen during research, for later comparison only: Auth0 B2B Essentials ($150 per month with 3 SSO connections), Stytch B2B (5 free connections, then $125 each; now part of Twilio), Descope (Pro $249 per month with 5 connections), SSOReady (open source, free core, SOC 2 not named).

## What the existing code does, and where it falls short

Verified on `origin/main` at `3ecb58f1`.

What works:

- `artifacts/api-server/src/lib/auth/oidc.ts` runs an authorization-code flow with PKCE, a signed state cookie, nonce, discovery with exact issuer match, RS256 signature check against JWKS with key refresh, audience and `azp` checks, and expiry checks.
- It refuses login unless `amr` contains `mfa` when `OIDC_REQUIRE_MFA` is true. That variable defaults to true whenever any OIDC variable is set.
- `LOCAL_LOGIN_MODE` (`enabled`, `break_glass`, `disabled`) fails closed when it is unset or unrecognized: an unknown value, or SSO that is half configured with no mode set, disables local login. An explicit recognized mode always wins (`lib/auth/oidc.ts` lines 58-67), so `LOCAL_LOGIN_MODE=enabled` keeps password login open even while OIDC is half configured. Set the mode deliberately at each setup step.
- Successful SSO logins write an `auth.oidc.login` security event and mark the session `auth_method = 'oidc'`.

Gaps found:

1. **Entra will be refused as configured today.** Entra v2.0 ID tokens include `amr` only when the app registration requests it as an optional claim ([optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)). Without it, every Entra login fails the MFA check. Separately, `acr` exists only in v1.0 tokens as `0` or `1` ([access token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference)), so `OIDC_REQUIRED_ACR` must stay empty for Entra or it will refuse every login.
2. **Users are matched by email.** The callback looks up the user by `email`, then `preferred_username`, then `upn`. Microsoft says these are mutable and must not be used for authorization, and that apps should key on `tid` plus `oid` ([claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation)). A tenant admin who can set a user's email could otherwise sign in as a Truenote account in another program.
3. **One issuer for the whole deployment.** Configuration comes from environment variables, so only one customer tenant can sign in. There is no record of which tenant may reach which program.
4. **Local login checks the password before the policy.** In `routes/auth.ts` lines 167-184 the password is verified first, then the user gets "Use company SSO to sign in." (403) instead of "Invalid credentials" (401). Once SSO-only accounts exist, that difference confirms a correct password.
5. **Existing local sessions survive a mode switch.** `findSessionByToken` in `lib/auth/sessions.ts` does not check `auth_method`. After `LOCAL_LOGIN_MODE` changes to `break_glass`, every CSR's existing password session stays valid for up to seven days.
6. **Sessions last seven days with no idle timeout.** The October 9 security review already lists idle reauthentication as a gap. With SSO there is a second effect: a user disabled in Entra keeps Truenote access until the session ends, because Entra does not notify custom apps ([Continuous Access Evaluation](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation) covers Microsoft's own services).
7. **No lockout for local accounts.** The only limit is 2,000 attempts per IP per 10 minutes (`loginIpLimiter`). Fine for SSO users, whose IdP locks out; not enough for the break-glass account.
8. **The break-glass account has no MFA.** A second factor added only to `POST /login` would not be enough: `POST /api/auth/reset-password` (`routes/auth.ts` lines 586-626) issues a session as soon as a valid reset link is used, including for a `super_user` in `break_glass`.
9. **Logout is local only.** Signing out of Truenote leaves the Entra session open, so the next "Sign in with SSO" succeeds without a prompt. Acceptable on dedicated agent desktops, worth knowing on shared ones.

## Design

### Customer connections

A new `sso_connections` table, managed by the super_user:

- `provider` (`entra` now, `workos` later), `tenant_id`, `issuer` (`https://login.microsoftonline.com/{tenant_id}/v2.0`), email domains used to find the connection on the login page, `require_mfa` (default true, cannot be turned off without a recorded exception), `jit_enabled` (default false), `status`.
- A separate allow-list of programs the connection may reach. One connection can serve several programs, and one program can accept several connections. This covers outsourcers whose CSRs from one tenant work several client programs, and a client whose own staff sign in from a different tenant.

The first connection is the employer's own single-tenant app registration, so a connection row can carry its own client ID and a reference to its secret. From the second customer on, one multi-tenant Entra app registration, owned by Truenote's tenant and limited to work accounts ("Accounts in any organizational directory"), serves every customer. Each customer's admin grants consent once. Truenote never uses the `/common` endpoint: the login page asks for a work email, finds the connection by domain, and sends the user to that tenant's own authority. The existing exact issuer check then applies per connection, and the callback also checks that `tid` equals the connection's tenant.

### Identity binding

A new `user_identities` table: `(issuer, subject)` unique, plus `tenant_id`, `object_id`, `user_id`, `connection_id`, created and last-used timestamps.

- First SSO login: the user must already have an invited, active Truenote account. The email from the token is used only to find that invitation, and only if the token's tenant matches the connection and the account's program is on the connection's allow-list. The identity is then bound to `tid` and `oid`. A token whose `xms_edov` claim is false (email not verified by the domain owner) never binds.
- Each invitation records the connection it is for, and a first login binds only through that connection. Without this, once two connections share a program (step 3b), a token from tenant B carrying the email of a pending invitation meant for tenant A could bind to that account. Microsoft documents this email-claim risk ([MSRC, June 2023](https://www.microsoft.com/en-us/msrc/blog/2023/06/potential-risk-of-privilege-escalation-in-azure-ad-applications)). With the employer's single connection the risk does not arise; it must be closed before the second connection.
- Every later login: look up by `(issuer, subject)` only. Email changes in Entra no longer matter.
- A token from tenant A can never reach an account in a program that tenant A's connection is not allowed into, even if the email matches.

### Provisioning, roles and programs

- **Now: invitation first.** A Truenote admin creates the account with role and program, as today. Role and program always come from Truenote's database, never from the token. SSO-only accounts get no usable password, and the password reset and invitation flows refuse them. The invitation itself changes too: today single and bulk invitations send a `/reset-password` link and ask the user to choose a password, which an SSO-only account cannot use. SSO accounts get an invitation email that links to the sign-in page and says to use the SSO button ("Continue with company SSO" on the sign-in page). Built in #239. Before it, single create returned a temporary password instead of sending a link; for an SSO account it now returns none and sends the sign-in email.
- **Optional just-in-time creation, per connection, off by default.** When on, a first-time user from that tenant gets an account in the connection's single default program with the `csr` role, or a role mapped from an Entra app role in the `roles` claim. JIT never creates `super_user`, `senior_manager` or `manager`.
- **SCIM later, with a trigger.** Build a SCIM 2.0 endpoint (or adopt WorkOS Directory Sync) before the second customer, or sooner if a customer has high staff turnover. Until then, offboarding relies on short sessions plus the customer removing the user in Entra, and a Truenote admin deactivating the account.

### MFA enforcement, two layers

1. **Customer side (Entra):** a Conditional Access policy that requires MFA, targeted at the Truenote enterprise app or at all resources, plus "Assignment required" on the enterprise app so only assigned users or groups can sign in. Conditional Access needs Entra ID P1 ([Conditional Access targeting](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-cloud-apps)). Security defaults are free, but Microsoft decides when ordinary users are prompted, so tokens will often lack `mfa` and the Truenote check will refuse those users ([security defaults](https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults)). Customers without P1 are therefore not supported at go-live.
2. **Truenote side:** the existing `amr` check. Microsoft emits `mfa` for Authenticator push, TOTP, SMS, FIDO2, passkeys, Windows Hello and Temporary Access Pass, and only after MFA was completed ([optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference)). It reflects the Entra session, not a fresh challenge per Truenote login; the customer's sign-in frequency setting controls how old that MFA can be.

If WorkOS is added later, its customers cannot be checked by layer 2. Before that happens, decide whether those customers sign a contractual MFA commitment and record the difference in the security documentation.

### Sessions

- SSO sessions: idle timeout (default 15 minutes, configurable; PCI DSS 8.2.8 asks for 15 when in scope) and an absolute limit of 10 hours, about one call-center shift. When the idle timeout fires, the user goes back through Entra. A user disabled in Entra is stopped there, but Entra usually signs everyone else in again silently, so the person at an unattended, unlocked browser gets back in without proving who they are. That is not re-authentication in the sense of PCI DSS 8.2.8 ([PCI SSC FAQ 1147](https://www.pcisecuritystandards.org/faqs/1147/)). Two ways to close it were offered: the sign-in after an idle expiry sends `prompt=login` (or `max_age`) to Entra and Truenote checks `auth_time` in the returned token; or the customer enforces a workstation screen lock of 15 minutes or less, and that is recorded as the control. The owner chose `prompt=login` on October 10. As built: when the idle limit ends an SSO session, the response sets a `truenote_oidc_reauth` cookie (path `/api/auth/oidc`, lifetime `SSO_SESSION_MAX_HOURS`); the next `GET /api/auth/oidc/start` sends `prompt=login` (as it does when the browser still holds a session cookie that no longer resolves to a session, which covers a lost or concurrent idle response), and the callback refuses the sign-in unless the ID token's `auth_time` is no earlier than that start, less 60 seconds of clock allowance. `max_age` is not sent: Microsoft's OIDC reference documents `prompt=login` and not `max_age` (checked October 10). `auth_time` is an Entra optional claim, so the app registration must add it (request list item 2); without it every sign-in after an idle expiry is refused. A flow started before the session idled out is restarted at the callback with `prompt=login`. Limit: both signals live in the browser, so someone who deletes the marker and the session cookie before signing in gets a silent sign-in. Sign-ins that do not follow an idle expiry (the first of the day, after logout, after the 10-hour limit) stay silent when Entra allows it. Measure how often CSRs hit this between calls before fixing the defaults.
- Session lookup refuses a `local` session for any user whom the current `LOCAL_LOGIN_MODE` would not allow to log in locally. A mode switch takes effect on the next request.
- Local sessions get the same idle limit whenever `LOCAL_LOGIN_MODE` is not `enabled`, which covers the emergency super_user in `break_glass`. Its absolute limit stays the local seven days unless the owner sets a shorter one; record that as an accepted exception under AC-12.
- Logout stays local by default. Optional: send the user on to Entra's `end_session_endpoint` for shared workstations.

### Local login and the emergency super_user

- Fix the order in `POST /login`: decide whether the account may use local login before verifying the password. If not, run the dummy hash verify (to keep timing equal) and return the same 401 "Invalid credentials". The login page already offers "Sign in with SSO".
- Production runs `LOCAL_LOGIN_MODE=break_glass` from go-live: only `super_user` may log in locally.
- Second factor for that account, recommended: a passkey through WebAuthn, on a hardware security key (FIDO2) or a platform passkey provider such as Windows Hello, iCloud Keychain or Google Password Manager, plus ten single-use recovery codes stored as hashes, printed and kept offline. Microsoft Authenticator cannot hold this passkey: it supports passkeys only for Microsoft Entra ID ([passkey FAQ](https://learn.microsoft.com/en-us/entra/identity/authentication/passkey-faq)). Passkeys resist phishing; TOTP does not. Cheaper option: TOTP in Microsoft Authenticator with the secret encrypted at rest.
- Password reset must not bypass the factor. A reset link for a user with a passkey, or for a `super_user` in `break_glass`, sets the password and ends the user's sessions but issues no session; the user then signs in through `/login` and the second factor.
- Lockout for local accounts: after 5 failed attempts, lock for 30 minutes and write a security event. Every break-glass login writes `auth.break_glass.login` (already exists) and should alert the owner once SIEM delivery exists.
- If go-live arrives before the second factor is built, record a written exception: the super_user account stays deactivated (`is_active = false`); it is activated only by the owner through `railway ssh` (the owner's Railway and GitHub accounts must have MFA on), with a dated record of reason, start and end, and deactivated after use.

## Controls this affects

The repository has no NIST 800-53 control mapping and no POA&M file on `main`. The nearest records are the October 9 security review rows "OIDC and MFA" (Configuration required) and "Idle reauthentication" (Gap), and the P0 gate in `.claude/skills/review-security-posture/SKILL.md`, which lists SSO/MFA. The mapping below is proposed and should become POA&M entries once a POA&M exists. The first customer's security reviewer asked for the Moderate baseline, which includes IA-2(1), IA-2(2), IA-2(8), IA-2(12), AC-2 enhancements (1) to (5) and (13), AC-7, AC-11, AC-12 and IA-11.

| NIST 800-53 Rev 5 | What this plan does | Remaining after the plan |
|---|---|---|
| IA-2, IA-2(1), IA-2(2) | MFA for all customer users through the IdP, checked by Truenote; MFA for the break-glass account | MFA itself is the customer's responsibility (shared control); needs a customer responsibility statement |
| IA-2(8) | Replay-resistant methods depend on the customer's allowed methods (Authenticator push with number matching, FIDO2) | Truenote cannot see which method was used beyond `amr` values |
| IA-2(12) | Not applicable unless the customer issues PIV credentials | Written justification for the package |
| IA-4 | Accounts bound to immutable `tid` plus `oid` | |
| IA-5, IA-5(1) | Passwords limited to one account; existing 15-character minimum stays | Break-glass credential handling procedure |
| IA-8 | If customer users are treated as non-organizational users, the same controls apply | Classification decision |
| IA-11 | Idle timeout sends users back through the IdP; the sign-in after an idle expiry sends `prompt=login` and requires a fresh `auth_time` | The signals that trigger it are browser cookies (the marker and the stale session cookie); deleting both before sign-in skips the prompt |
| AC-2, AC-2(2), AC-2(3), AC-2(4), AC-2(13) | Invitation records, emergency account defined and kept inactive or MFA-protected, short sessions after Entra disable, security events for account changes | AC-2(1) automated account management needs SCIM; AC-2(3) inactive-account disabling needs a scheduled job |
| AC-7 | IdP lockout for SSO users; new lockout for local accounts | |
| AC-2(5), AC-12, SC-23 | Idle and absolute session limits; idle limit on local sessions outside `enabled`; session invalidation on mode change | Emergency local session keeps the seven-day absolute limit unless shortened (recorded exception) |
| AC-11 | Truenote's idle timeout ends the application session | Screen lock on CSR workstations is the customer's control |
| AU-2, AU-12 | Existing login security events, plus new events for connection changes, identity binding, lockout and refused MFA | External delivery still depends on the SIEM gap |

PCI DSS v4 rows in the existing review that move: 8.4.2 (MFA for access), 8.2.8 (idle timeout), 8.3.4 (lockout, for the local account), 8.2.6 (inactive accounts, partly, until SCIM).

New risks to record:

- **Entra outage or misconfigured Conditional Access** blocks all customer users. Break-glass access keeps the owner able to administer, not CSRs able to work.
- **Client secret expiry** stops all SSO logins. Entra secrets last at most 24 months and Microsoft recommends under 12, and recommends certificates over secrets for production ([credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)). Keep a rotation date and an alert; move to certificate (`private_key_jwt`) authentication later.
- **Multi-tenant validation errors** would let any Entra tenant sign in. Covered by the hostile-tenant tests below.
- **Unverified publisher.** Customer admins will see "unverified" on the consent screen until Truenote completes Microsoft publisher verification, which needs a Microsoft AI Cloud Partner Program ID.
- **Revocation lag** up to the idle timeout (or the absolute limit for an active user) after a user is disabled in Entra, until SCIM exists.
- **Token handling:** Truenote stores no Entra tokens after the callback. Keep it that way.

## Build plan and effort

Estimates are engineering days for one developer, including tests. Nothing starts without the owner's go.

| Step | Work | Effort |
|---|---|---|
| 1 | Local login order fix; session lookup refuses local sessions the current mode disallows; per-account lockout | 1 day |
| 2 | `user_identities` table (SQL migration), bind on first login, look up by issuer and subject, tenant check, refuse SSO users in password reset and invitation flows, SSO invitation email | 2 days |
| 3a | `sso_connections` and program allow-list tables (SQL migration) holding the employer's single connection; callback checks `tid` and the program allow-list | 1 day |
| 4 | Idle and absolute SSO session limits, configurable; idle limit on local sessions outside `enabled` | 1-1.5 days |
| 5 | Break-glass passkey plus recovery codes (or TOTP, about 1.5 days); reset links no longer sign in a user who has a second factor | 2-3 days |
| 6 | Real Entra tests with the employer's tenant (below), security docs and Moderate package evidence | 2 days |
| | **Total before go-live** | **9-10.5 days** |
| 3b | Before the second customer: login page asks for work email and routes to the tenant, per-connection issuer and credentials, invitations bound to their connection, Truenote multi-tenant app, super_user admin screen for connections, hostile-tenant tests | 3 days |
| Later | Optional JIT per connection | 1 day |
| Later | SCIM 2.0 endpoint, or WorkOS Directory Sync | 4-6 days, or 2-3 with WorkOS |
| Later | WorkOS SSO connection type | 2-3 days |
| Later | Entra end-session redirect and front-channel logout | 1 day |
| Later | Certificate client authentication | 1 day |

Steps 2 and 3 include schema changes. Each follows the repository's procedure: a numbered file in `lib/db/sql/`, a dry run, and the owner's go before `--apply` on production.

## First customer: request list for the employer's IT team

The first customer is the owner's employer, whose security reviewer asked for the NIST 800-53 Moderate package and approves on the customer's side (owner fact of October 9, relayed through another working session). The employer already uses Microsoft Authenticator, and its IT team sets every Entra-side setting.

For this customer the app registration lives in the employer's tenant (single tenant), owned by their IT. Truenote then needs no Entra tenant of its own, the existing environment-variable configuration fits one tenant as it is, and the employer keeps control of consent, assignment and MFA. The multi-tenant Truenote app described under "Customer connections" becomes the route for the second customer.

Send this list to the employer's IT team:

1. **App registration.** Create one in your tenant named "Truenote". Supported account types: "Accounts in this organizational directory only". Platform: Web. Redirect URIs: `https://truenote.org/api/auth/oidc/callback`, and for pre-go-live testing only `https://web-production-62818.up.railway.app/api/auth/oidc/callback` (remove it after go-live). Leave the implicit grant "ID tokens" and "Access tokens" boxes unticked.
2. **Token configuration.** Add optional claims to the ID token: `amr`, `auth_time`, `email`, `preferred_username`, `xms_edov`. Accept the prompt to add the Microsoft Graph `email` permission.
3. **API permissions.** Microsoft Graph delegated `openid`, `profile`, `email` only, with admin consent granted. No other permissions.
4. **Credential.** Create a client secret with a 12-month expiry. Send the secret to the Truenote owner through a channel your security team approves (not plain email), and tell us the expiry date and who renews it.
5. **Identifiers.** Send the Directory (tenant) ID, the Application (client) ID, and the email domains your users sign in with.
6. **Enterprise application.** Under Properties set "Assignment required?" to Yes. Assign a small test group first; assign the CSR, supervisor and manager groups only at go-live.
7. **Conditional Access.** A policy for the assigned groups, target resource the Truenote app (or all resources), grant "Require multifactor authentication" or the "Multifactor authentication" authentication strength (a phishing-resistant strength is stronger if your users have passkeys). Run it in report-only first, then turn it on. Tell us the sign-in frequency setting.
8. **Test accounts.** One user in the test group with Authenticator; one user temporarily excluded from the Conditional Access policy (to prove Truenote refuses a login without MFA); one user not assigned to the app. Remove the exclusion after testing.
9. **Evidence for the Moderate package.** After testing, export the Entra sign-in log entries for the test sign-ins showing the MFA result, and screenshots or exports of the app registration claims, assignment setting and Conditional Access policy.
10. **Offboarding and guests.** Name a contact who tells Truenote when an assigned user leaves (until SCIM exists), and say whether any guest (B2B) users need access.

Truenote's side after receiving items 4 and 5, with the owner's go for the Railway variable change: `OIDC_TENANT_ID` set to the Directory (tenant) ID, `OIDC_ISSUER_URL=https://login.microsoftonline.com/<tenant-id>/v2.0` (its tenant segment must equal `OIDC_TENANT_ID`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, a new 32-byte `OIDC_STATE_SECRET`, `OIDC_REQUIRE_MFA=true`, `OIDC_REQUIRED_ACR` empty, `OIDC_ALLOWED_DOMAINS` set to the employer's domains, `OIDC_ALLOWED_PROGRAM_IDS` set to the UUIDs of the Truenote programs the employer's users belong to, and `LOCAL_LOGIN_MODE` set explicitly. As built in #226, SSO stays off (`/api/auth/oidc/start` answers 503) unless `OIDC_TENANT_ID` matches the issuer and `OIDC_ALLOWED_PROGRAM_IDS` holds at least one valid UUID. The full order is in `.claude/reference/deployment.md`, "SSO and emergency sign-in release".

## Later customers in Entra

For the second customer, Truenote creates its own Entra tenant and one multi-tenant app registration ("Accounts in any organizational directory", the same Web redirect URI and optional claims, a 12-month secret or a certificate) and starts publisher verification, which needs a Microsoft AI Cloud Partner Program ID. Each customer's admin then:

1. Grants admin consent to the Truenote app.
2. On the Truenote enterprise app, sets "Assignment required" to Yes and assigns the CSR, supervisor and manager groups (group assignment needs P1).
3. Creates a Conditional Access policy requiring MFA for those users, targeting the Truenote app or all resources.

## Test plan

Unit tests extend `lib/auth/__tests__/oidc.test.ts` with locally signed tokens: wrong issuer, wrong `tid`, missing `amr`, `amr` without `mfa`, wrong audience, expired token, nonce mismatch, replayed state, unknown key id.

Real Entra tests for go-live use the employer's tenant with the test accounts from the IT request list. Step 3b adds a second, hostile tenant to prove that a token from another tenant cannot reach the employer's program; that tenant needs Entra ID P1 or a P2 trial only if Conditional Access is tested there too. Options for it: a new tenant through an Azure account, or the Microsoft 365 Developer Program sandbox if the owner qualifies (it requires a Visual Studio subscription or partner status). Railway has only the production environment, so these tests run on production before go-live, with only test accounts and demo data, after the owner approves the variables. A separate Railway staging environment is the cleaner option and is a paid change for the owner to decide.

| Case | Expected result |
|---|---|
| Tenant A user with Authenticator MFA | Signed in; session `auth_method = 'oidc'`; security event written |
| Tenant A user, Conditional Access excluded, password only | Refused (no `mfa` in `amr`); refusal recorded |
| Tenant A user with a passkey or Windows Hello | Signed in (`amr` includes `mfa`) |
| Tenant A user not assigned to the app | Stopped by Entra before reaching Truenote |
| Tenant B user whose email matches a Truenote account in program A (step 3b) | Refused; no identity bound |
| Tenant B user whose email matches a pending invitation for tenant A in a program both connections serve (step 3b) | Refused; no identity bound |
| SSO user invited by single or bulk invitation | Email links to the sign-in page, not `/reset-password`; first "Sign in with SSO" binds the identity |
| SSO user returns after the idle limit | Entra asks for credentials again (`prompt=login`); the new session is created only when the token's `auth_time` is fresh |
| Sign-in after an idle expiry whose token has an old or missing `auth_time` | Refused; security event `auth.oidc.login` denied with reason `reauth_auth_time_stale` or `reauth_auth_time_missing` |
| Tenant A user whose program is not on the connection's allow-list | Refused |
| User's email changed in Entra after first login | Same Truenote account |
| User disabled in Entra, then idle | Session ends at the idle limit; the next sign-in through Entra is refused |
| User disabled in Entra, still active in Truenote | Session continues until the absolute limit (10 hours), then the next sign-in is refused. Accepted until SCIM exists |
| Deactivated Truenote account | Refused |
| Tampered state, reused callback, expired state | Refused |
| SSO-only user enters the correct password on the local form | Same 401 and similar timing as a wrong password |
| Mode switched to `break_glass` | Existing CSR password sessions refused on next request |
| Break-glass login: password plus passkey, wrong factor, recovery code reused, 5 failures | Success; refused; refused; locked with a security event |
| Break-glass super user follows a valid reset link | Password set, sessions ended, no session issued; `/login` then asks for the second factor |
| SSO user asks a question | Retrieval stays within the user's program (existing program-scope tests still pass) |

The eval harness is not affected; no retrieval or generation code changes.

## Decisions needed from the owner

1. Approve direct Entra now with WorkOS deferred, or choose WorkOS now.
2. Passkey or TOTP for the break-glass account.
3. Idle re-authentication for SSO users: `prompt=login` (or `max_age`) after an idle expiry, or a customer screen-lock control recorded instead. Decided October 10: `prompt=login`, built as described under "Sessions".
4. Whether to add a Railway staging environment, or test on production before go-live with test accounts only.
5. When to send the request list to the employer's IT team.
6. Go-ahead for steps 1 to 6.

## Sources

Microsoft (checked October 9, 2026):

- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/access-token-claims-reference
- https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation
- https://learn.microsoft.com/en-us/entra/identity-platform/howto-convert-app-to-be-multi-tenant
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols-oidc
- https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials
- https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-cloud-apps
- https://learn.microsoft.com/en-us/entra/identity/conditional-access/policy-all-users-mfa-strength
- https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-continuous-access-evaluation
- https://learn.microsoft.com/en-us/entra/fundamentals/security-defaults
- https://learn.microsoft.com/en-us/entra/identity/app-provisioning/user-provisioning
- https://learn.microsoft.com/en-us/office/developer-program/microsoft-365-developer-program-faq

WorkOS and others (checked October 9, 2026):

- https://workos.com/pricing
- https://workos.com/docs/sso/guide/introduction
- https://workos.com/docs/reference/sso/profile
- https://workos.com/docs/admin-portal
- https://workos.com/docs/directory-sync/handle-inactive-users
- https://workos.com/docs/authkit/mfa
- https://workos.com/docs/mfa
- https://workos.com/security and https://trust.workos.com
- https://auth0.com/pricing, https://stytch.com/pricing, https://descope.com/pricing, https://ssoready.com/pricing

Not confirmed: the WorkOS price time unit, whether WorkOS custom attributes can carry `amr`, WorkOS data retention, Entra licensing for SCIM provisioning to a custom app, and P2 trial length.
