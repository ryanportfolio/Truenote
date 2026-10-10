# Fixture API for local review

In-memory stand-in for the api-server so the Sources page (`/kb`), the document reader (`/kb/:id`), Source usage (`/admin/sources`), Content gaps, Users, Teams (`/admin/teams`) and Chat render locally, for the CSR, supervisor, manager and super-user roles. Plain Node, no dependencies, port 5099.

It is a hand-written copy of the real API, so it can drift from it. A check here proves the SPA against fixture data: layout, interactions and the requests the client sends. It proves nothing about the server, the database, retrieval or production data; those need the deployed Railway service.

## Start (Git Bash, from the worktree root)

One command starts both the fixture API and the SPA (Vite proxies `/api` to the fixture). `MOCK_PORT` (default 5099) and `VITE_PORT` (default 5180) pick the ports; stopping the process stops both:

```bash
node scripts/preview/review-env.mjs
```

The desktop app's Browser pane starts the same pair with `preview_start` on the `rag-app-preview` entry in `.claude/launch.json`. Then open http://localhost:5180/.

Or by hand, terminal 1, the fixture API:

```bash
node scripts/preview/mock-api/server.mjs
```

Terminal 2, the SPA with Vite proxying `/api` to the fixture:

```bash
API_PORT=5099 corepack pnpm --filter @workspace/rag-app run dev
```

Open http://localhost:5173/. Without a role cookie you are Maria Chen (manager).

Smoke check (server must be running; it resets state at the start and end):

```bash
node scripts/preview/mock-api/smoke.mjs
```

Stop the server with Ctrl+C in terminal 1. If it runs in the background, find and kill it:

```bash
netstat -ano | grep ":5099" | grep LISTENING
taskkill //PID <pid> //F
```

## Switch role

Open one of these in the browser. Each sets the `mock_user` cookie and redirects to `/`:

| URL | Signed in as |
|---|---|
| http://localhost:5173/api/__mock/as/csr | Jordan Reyes, CSR on Renee's team (pins, notes, personal colors, chat history, Renee's recommended sources) |
| http://localhost:5173/api/__mock/as/supervisor | Renee Alvarez, supervisor (Recommend to my team; Teams, Users, Usage and Gaps for her own team) |
| http://localhost:5173/api/__mock/as/demo_supervisor | Elliot Brooks, demo supervisor (his recommended list shows to his team; writes refused with "Demo accounts can't do this") |
| http://localhost:5173/api/__mock/as/manager | Maria Chen, manager (can organize, moves CSRs between teams) |
| http://localhost:5173/api/__mock/as/demo_manager | Demo Manager (manager role, library writes refused with "Demo accounts can't do this"; pins, notes and personal colors allowed) |
| http://localhost:5173/api/__mock/as/super_user | Sam Okafor, super user (program picker; no program selected until you pick one) |
| http://localhost:5173/api/__mock/as/out | Signed out (login page; any listed email signs in, any password) |
| (sign in from the login page) | Rowan Hale, `emergency@truenote.example`, super user with a passkey: the password step asks for a second factor (see Emergency sign-in below) |

The login page lists three demo accounts (CSR, Supervisor, Manager), from `demoAccounts` in `/api/config`. A first name also works (`/api/__mock/as/aisha`, `/api/__mock/as/kim` for a CSR on Elliot's team). Through the Vite proxy (`xfwd: true` adds `X-Forwarded-Host`) the redirect is a relative `Location: /`, so it lands on whatever port Vite runs on; checked with Vite on another port (`curl -D - http://localhost:<vite port>/api/__mock/as/csr` gives `302`, `Location: /`, `Set-Cookie: mock_user=<id>`). `http://localhost:5099/__mock/as/<role>` works too and redirects to `http://localhost:5173/` (cookies on localhost are shared across ports; `PORT` overrides 5173).

## Other controls

| URL | Effect |
|---|---|
| `/api/__mock/reset` | Reseed all state (library, questions, views, pins, notes, teams, recommended lists, Ask examples) |
| `/api/__mock/fail?path=/api/kb/documents` | That exact path now returns 500 (error states); `/api/__mock/fail` clears all |
| `/api/__mock/delay?ms=1500` | Delay every API response (loading skeletons); `ms=0` turns it off |
| `/api/__mock/login-mode?mode=break_glass` | Sets the `LOCAL_LOGIN_MODE` stand-in (`enabled`, `break_glass`, `disabled`; reset restores `enabled`). `/api/config` reports it, and Users admin create and bulk import answer with SSO invitations for roles it excludes. A name containing `__mock_email_fail` makes the single-create invitation report an unsent email |
| `/api/__mock/audit` | Writes recorded with the server's action names (`kb.library.*`, `team.assign`, `ask.examples.set`) |
| `/api/__mock` | Users, ids, current failures and delay |

`MOCK_DELAY_MS=800 node scripts/preview/mock-api/server.mjs` starts with a delay.

## What the seed contains

Program "Acme Wireless Care" (plus "Northwind Insurance", empty, for the super-user empty state).

- 30 documents: 27 live and internal, 1 confidential ("Fraud team handoff: account takeover", hidden from CSRs), 1 restricted ("Executive escalations contact list", shown as a null title to managers in Source usage), 1 retired ("Legacy unlimited plan grandfathering", cited 60+ days ago, `isLive: false`). Each has a markdown body with headings, a numbered list, a bullet list, a table and notes.
- New (14 days): "Paperless billing opt-out" (1 day), "Payment extension requests" (3 days), "Service outage credits" (9 days), plus new versions of "Refund eligibility: annual plans" (6 days) and "Password reset and account unlock" (12 days). The two updated documents have an older version 1, so older citations open a superseded version.
- Never cited: "Hold and transfer etiquette" (viewed often), "Student discount verification", "Accessibility services: TTY and relay calls", "Paperless billing opt-out".
- Long title: "Temporary service suspension for military deployment, extended medical leave, or natural disaster relief (all regions)".
- Categories: Billing > Refunds > Annual plans (3 levels), Billing > Fees, Billing > Payments, Account security > Identity verification, Retention, Plans and service, Escalations (0 documents). "Refund eligibility: annual plans" is in both Annual plans and Retention. Five visible documents have no category (Not in a category group).
- Tags: Policy, Script, Compliance, Updated, Quick reference, Escalation.
- Team pins (the manager's "Recommend to everyone"): Cancellation fee schedule, Caller identity verification (3-point check), Service outage credits.
- Supervisor teams: Renee Alvarez leads Jordan, Aisha and Marcus; Elliot Brooks (demo account) leads Tomas, Kim and Priya; Devon Clarke is unassigned. Renee recommends "Late payment fee waivers" and "Retention offers by tenure" to her team; Elliot recommends "Plan change: proration rules" and "International roaming add-ons". So Jordan's Recommended group shows 5 sources, Kim's shows Elliot's 2 plus the 3 team pins, and Devon's shows the 3 team pins only. Both supervisors are added after every other seed row, so the rest of the seed is the same as before they existed. Neither asks questions or opens sources.
- Ask examples: none stored, so `/api/ask-examples` returns the three built-in defaults until a manager saves a list.
- Jordan (CSR): 6 pins (refund annual, password reset, late fee, identity verification, address change, outage credits), 4 notes (one note without a pin; the outage credits note is over 300 characters), reader opens on 8 documents spread over the last 10 days (`lastViewedByMeAt`, for "Recently opened"), 9 personal source colors (4 red: Cancellation fee schedule, late fee, device return, billing dispute; 2 green: Refund eligibility: annual plans, password reset; 2 amber: roaming, plan change; 1 blue: Caller identity verification), 3 color names (red "Read before quoting fees", green "Easy wins", amber "Changes often"), 1 personal category color (Retention pink over the team's violet). Questions in the last 7 days, so the 7-day window filtered to Jordan has data.
- Restricted source in Source usage: Maria (confidential clearance) cited "Executive escalations contact list" (restricted) 8 and 33 days ago, so the 30-day and 90-day windows list it with `title: null`, and `/source-usage/questions?documentId=<its id>` returns 404.
- About 320 questions over 90 days from 6 CSRs and Maria, cited documents on a power-law curve, about 11% refused, some thumbs-down. Priya Shah has no questions in the last 20 days (empty 7-day state when filtered to her). Devon Clarke is a new hire with no questions at all (empty state for any window).
- 520 reader opens over 90 days. Opening a document records a view unless the same user opened it in the last 30 minutes.

## Rules the fixture enforces (Amendment v2)

- Personal colors: `PUT /api/kb/documents/:id/color` and `PUT /api/kb/categories/:id/color` take `{ color }` (a palette color or `null`), for every role including demo. A source must be visible to the user and a category must be in the effective program, else 404. Colors are private: one user's colors never show for another.
- `myColor` is on every list item, every category (team `color` unchanged) and the reader response, which also carries `pinnedAt`, `note` and `noteUpdatedAt`. Pin, note and color responses include `color`.
- The personal row is deleted when pin, note and color are all null. A category color of `null` deletes that user's category preference; deleting a category drops every user's preference for it.
- `PUT /api/kb/library/featured`: team pins on documents the manager cannot see stay in place and count toward the cap; more than 12 in total returns 400 "Team pins are limited to 12." and changes nothing. `PUT /categories/:id/documents` keeps memberships of hidden documents the same way.
- `/api/admin/insights/source-usage` returns `person` (the filtered user, any window, or null), `people` (every active csr, supervisor, manager and senior_manager in the program with their window question count, Devon Clarke at 0, sorted by name) and `matrix` (top 10 sources for everyone in the window, rows in `users` order; ignores `userId`).
- Color names: `GET /api/kb/documents` returns `labels: { color, name }[]` for the signed-in user (palette order, also when no program is selected). `PUT /api/kb/labels/:color` takes `{ name }`: trimmed, 1 to 40 characters; `null` or blank text removes it; returns `{ item: { color, name } | null }`. Unknown color, a missing `name` or over 40 characters is 400. Every role, demo included; names are private.
- `/api/admin/insights/source-usage` returns `suggestions` (empty without `userId`, else up to 3): "related" first (live sources teammates cited in the window under the same top-level category as the sources behind the person's thumbs-down answers, or, for refused questions, behind teammates' answers to the same normalized question), or, only when none exist, "team_top" (the team's most cited with at least 3 team answers in the window; the two reasons never mix, same as the backend). Never a source the person cited in the window, one the person's clearance hides, a retired one, or one whose title the viewer cannot see. Ties: more team answers, then the latest team answer, then document id. Jordan gets "related" ones (a refused "Do we price-match competitor promotions?" that Tomas and Aisha got answered from Retention, and a thumbs-down on the late fee); Aisha gets one "related" in 30 days (her own refused price-match question, which Tomas got answered from Retention); Devon gets 3 "team_top". The smoke check recomputes this rule from the seed rows for every person and window and compares.
- Grouping and "Show more": Aisha, Marcus, Kim and Tomas asked "What is the cancellation fee for Unlimited Plus?" in four spellings, all citing Cancellation fee schedule, which has well over 12 citing questions in the 30-day window.
- `/api/admin/insights/source-usage/questions?documentId=` returns 404 for a source whose title the viewer cannot see.

## Supervisor rules (from PR #191)

These mirror `routes/kb.ts`, `routes/kb-library.ts`, `routes/admin/teams.ts`, `routes/admin/users.ts`, `routes/admin/insights.ts` and `routes/ask-examples.ts`.

- Role rank: csr 20, supervisor 40, manager 60. Every manager+ route stays closed to supervisors.
- `GET /api/kb/documents`: each item has `teamPinPosition`, the source's place in the viewer's team list: a supervisor's own list, a CSR's supervisor's list in the same program, and null for everyone else. The response has `canPinForTeam`, true only for a supervisor who is not a demo account (also when no program is selected).
- `PUT /api/kb/library/team-shortcuts` takes `{ documentIds }` and replaces the caller's own list. Any role but supervisor gets 403 "Only supervisors can recommend sources to a team."; a demo supervisor gets 403 "Demo accounts can't do this". Ids must be uuids (400 otherwise) and are lowercased; the same id twice in any case, or more than 12 ids, is 400; a source the supervisor can't see is 404; their hidden rows stay and count toward the 12. Other supervisors' lists are never touched.
- `GET /api/admin/teams` (supervisor and above) returns `{ supervisors, csrs, canEdit }`: active supervisors and CSRs in the program, sorted by name, with each CSR's `supervisorId` (null when unassigned). A supervisor gets only themselves and their own CSRs, with `canEdit: false`. No program selected is 400.
- `PUT /api/admin/teams/assignments` (manager and above, not demo) takes `{ csrIds, supervisorId }`, where `supervisorId: null` unassigns. 1 to 200 ids; each must be an active CSR in the program and the supervisor an active supervisor there, else 400 with the server's message. Returns `{ csrs }` for the whole program.
- Supervisor scope: `GET /api/admin/users` lists only the CSRs on their team. Source usage (people, matrix, totals, sources, views, suggestions) and Content gaps count only their team's questions (themselves plus their CSRs); a `userId` outside the team is 404. `/api/admin/queries` (the Gaps review queue) and `/api/admin/programs` stay manager+.
- `POST /api/admin/users/:id/reset-password` (supervisor and above, not demo) returns `{ tempPassword }` and sets the target's `mustResetPassword`. A supervisor may reset only a CSR on their own team; a manager follows `canManageUser` (CSRs and supervisors in their program, never themselves). Only a super user may reset a demo account (403 "Demo accounts can't do this"), whatever the demo-limits switch says. Anyone out of scope is 404; a malformed id is 400. `POST /api/auth/change-password` accepts any password and clears `mustResetPassword`.
- `GET /api/ask-examples` (every role, program required) returns `{ questions, custom }`: the three defaults with `custom: false` until a manager saves a list. `PUT` (manager and above, not demo) takes `{ questions }`: up to 6, each trimmed to 1 to 200 characters, repeats dropped case-insensitively; an empty list restores the defaults.
- `GET /api/admin/programs`: a super user gets every program, a manager or senior manager their own.

## Demo limits (Security page)

- `GET /api/admin/security` (super user only) returns the Security dashboard. The malware scanner part is a fixed stub (enforcement on, no endpoint, no findings); `demoLimits` is live.
- `PATCH /api/admin/security/demo-limits` (super user only) takes `{ enabled }` and records a control event. With `enabled: false`, every "not demo" rule above lets demo accounts through, and `canOrganize` and `canPinForTeam` follow. The switch resets to on when the server restarts.
- `GET /api/compliance/documents` and `GET /api/compliance/documents/:slug` (super user only) serve two invented compliance documents; the first has a table. A malformed slug gets 400, an unknown one 404, and each document read is added to `/__mock/audit`.

## Emergency sign-in (break-glass MFA)

Mirrors `routes/mfa.ts` and the MFA branch of `POST /api/auth/login` for the SPA flow only. **Fixture only: no WebAuthn cryptography.** The passkey endpoints accept any browser response whose credential id is registered to the account and never check a signature, an attestation, the challenge or the origin. The server's verification is covered by `artifacts/api-server/src/routes/__tests__/mfa-login.test.ts`, not here.

- Account: Rowan Hale, `emergency@truenote.example`, super user (any password at the password step). The seed gives Rowan one placeholder passkey that no real authenticator holds and the recovery code `mockrecoverycode` (type it as `mock-reco-very-code` or in capitals; it works once). Sign out first (`/api/__mock/as/out`).
- `POST /api/auth/login` for an account with a passkey returns `{ mfaRequired: true, methods: ["passkey", "recovery_code"], passkeyOptions }` and sets the httpOnly `mock_mfa` cookie (path `/api/auth/mfa`, 5 minutes) instead of a session. Accounts without a passkey sign in as before.
- `POST /api/auth/mfa/passkey` (an assertion) and `POST /api/auth/mfa/recovery-code` (`{ code }`) finish it: `{ user }` and the `mock_user` cookie. A wrong factor is 401 `Invalid credentials`; a missing, expired or used challenge is 401 with `code: "mfa_expired"`.
- Enrollment (super user, own account): `GET /api/auth/mfa/status`, `POST /api/auth/mfa/passkeys/options`, `POST /api/auth/mfa/passkeys`, `DELETE /api/auth/mfa/passkeys/:id`, `POST /api/auth/mfa/recovery-codes` (10 new codes, shown once). Each change takes `{ password }`; any password works except `wrong-password`, which returns 401 `Current password is incorrect` for the error state.
- The RP ID is `localhost`: open the SPA on `http://localhost:<port>`, not `127.0.0.1`. To try the passkey path, sign in with the recovery code, add a passkey on Security (`/admin/security`), sign out, then sign in again and choose "Use passkey". Headless checks can use a Chrome DevTools Protocol virtual authenticator (`WebAuthn.addVirtualAuthenticator`).
- `/api/__mock/reset` restores the seeded passkey and recovery code.

## Password reset links

Mirrors `POST /api/auth/reset-password` for the SPA flow only. No email is sent (`emailResetAvailable` is false, so the login page hides "Forgot password?"); open the reset page directly with a fixture token.

- Token: `mock-reset-<key>`, where `<key>` is anything `/api/__mock/as/<key>` takes. Each token works once until `/api/__mock/reset`. The new password needs at least 12 characters and is not stored (the fixture login takes any password).
- http://localhost:5173/reset-password?token=mock-reset-sam: Sam Okafor has no passkey, so the reset returns `{ user }`, sets the `mock_user` cookie and the SPA signs straight in.
- http://localhost:5173/reset-password?token=mock-reset-rowan: Rowan Hale has a passkey, so the reset returns `{ passwordReset: true, signInRequired: true }`, signs the browser out, records `auth.password_reset.sign_in_required` (reason `second_factor_required`) in the Security page's control events, and the SPA sends Rowan to `/login?reset=done` with the notice "Password changed. Sign in with your new password." The password step then asks for the second factor (Emergency sign-in above).
- Demo accounts (Jordan, Renee, Maria, Elliot, Demo Manager), inactive users, unknown keys and used tokens get 400 `This reset link is invalid or has expired`.
- The fixture runs in `enabled` local login mode, so the server's other sign-in-required reason (`break_glass_mfa_missing`, a break_glass super user without a passkey) is covered only by `artifacts/api-server/src/routes/__tests__/auth-reset-policy.test.ts`.

Chat answers come from a keyword match over the fixture library; a question with no match gets the refusal. New questions show up in Source usage right away.

## Endpoints

`/api/config`, `/api/me`, `/api/auth/login|logout|forgot-password|reset-password|change-password`, `/api/auth/mfa/passkey|recovery-code|status|passkeys|passkeys/options|passkeys/:id|recovery-codes`, `/api/sessions`, `/api/sessions/:id`, `/api/ask`, `/api/ask/stream`, `/api/feedback`, `/api/flag-missing`, `/api/kb/documents`, `/api/kb/documents/:id`, `/api/kb/documents/:id/pin|note|color|highlights`, `/api/kb/categories/:id/color`, `/api/kb/labels/:color`, `/api/kb/highlights/:id`, `/api/kb/library/*` (every route in `lib/api.ts`), `/api/admin/insights/kb-gaps`, `/api/admin/insights/source-usage`, `/api/admin/insights/source-usage/questions`, `/api/admin/queries`, `/api/admin/users`, `/api/admin/users/:id/reset-password`, `/api/admin/programs`, `/api/admin/teams`, `/api/admin/teams/assignments`, `/api/admin/security`, `/api/admin/security/demo-limits`, `/api/compliance/documents`, `/api/compliance/documents/:slug`, `/api/ask-examples`, `/api/documents` (read-only list). Anything else returns 404 and logs `[mock-api] no fixture for ...` in the server terminal.
