/**
 * Showcase seed for the source library, reader and Source usage pages on the
 * Railway demo (https://truenote.org, Demo Program). Everything except the
 * backdate step goes through the app's own HTTP API, so every write passes
 * the normal auth, program-scope and audit paths. First run: 2026-10-08.
 *
 *   corepack pnpm --filter @workspace/scripts run seed:showcase <step> [<step> ...]
 *
 * Steps, in order:
 *   upload    Upload the 15 showcase files in docs/demo-kb/files/ as the agent
 *             account and wait until each is ingested and live. Skips a file
 *             whose title already exists. Idempotent. The fraud handoff is
 *             sent as confidential and falls back to internal when the
 *             uploader's clearance refuses it (the agent's is internal).
 *   users     Create the 6 showcase CSRs (firstname.lastname@larkspur.example)
 *             and complete their forced password change. Skips users that
 *             already exist, which then must have credentials in the CSR
 *             secrets file. Idempotent.
 *   organize  Folders, tags, folder memberships and team pins as the agent.
 *             Replace-style per source, so a re-run restores this layout;
 *             it also replaces any team pins set by hand. Idempotent.
 *   ask       About 200 real POST /api/ask questions plus thumbs up/down.
 *             NOT idempotent: every run adds query_log rows and spends model
 *             calls. Refuses to run when the state file already holds asks
 *             (--again overrides).
 *   views     Reader opens (GET /api/kb/documents/:id). NOT idempotent: adds
 *             rows on every run, at most one per user and source per 30
 *             minutes.
 *   personal  Shortcuts, private notes, source colors and color names for
 *             two demo accounts and three CSRs. Idempotent; never changes a
 *             source or color that already has personal state.
 *   backdate  Spreads the created_at of the query_log rows, chat sessions,
 *             reader views and CSR accounts this seed created over the last
 *             90 days, in one transaction over `railway ssh` in the pgvector
 *             service. Only rows recorded in the state file. Runs once; a
 *             second run is refused. --dry-run writes the SQL to .tmp and stops.
 *   verify    Read-only checks of the library and Source usage endpoints.
 *   plan      Print the question plan; calls nothing.
 *
 * Needs:
 *   ~/.claude/secrets/truenote-agent.json      agent account (super_user); read only
 *   ~/.claude/secrets/truenote-demo-csrs.json  written by `users`; email -> password
 *   the Railway CLI logged in (backdate only)
 *   state file .tmp/showcase-seed-state.json (override with SHOWCASE_STATE):
 *     ids of everything the seed created; `backdate` cannot run without it.
 * The public demo account passwords come from GET /api/config (published).
 * No password, cookie or token is ever printed.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.SHOWCASE_BASE_URL ?? "https://truenote.org";
const PROGRAM_ID = "00000000-0000-0000-0000-0000000000aa";
const RAILWAY_PROJECT = "2aa5cb01-5438-4fbd-aade-626d4e252977";
const RAILWAY_ENVIRONMENT = "b35c4090-cbcd-4deb-9434-e9b63a309bd9";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FILES_DIR = path.join(REPO_ROOT, "docs/demo-kb/files");
const STATE_PATH = process.env.SHOWCASE_STATE ?? path.join(REPO_ROOT, ".tmp/showcase-seed-state.json");
const SECRETS_DIR = path.join(os.homedir(), ".claude/secrets");
const AGENT_SECRETS = path.join(SECRETS_DIR, "truenote-agent.json");
const CSR_SECRETS = path.join(SECRETS_DIR, "truenote-demo-csrs.json");
const ASK_SPACING_MS = 3000;

// ---------------------------------------------------------------------------
// Data

interface ShowcaseFile {
  file: string;
  title: string;
  classification: "internal" | "confidential";
}

const SHOWCASE_FILES: ShowcaseFile[] = [
  { file: "updating-a-payment-method.md", title: "Updating a Payment Method", classification: "internal" },
  { file: "plan-upgrades-and-proration.md", title: "Plan Upgrades and Proration", classification: "internal" },
  { file: "enterprise-seat-management.md", title: "Enterprise Seat Management", classification: "internal" },
  { file: "storage-limits-and-overage.md", title: "Storage Limits and Overage", classification: "internal" },
  { file: "two-factor-authentication-reset.md", title: "Two-Factor Authentication Reset", classification: "internal" },
  { file: "account-recovery-lost-email.md", title: "Account Recovery When the Email Is Lost", classification: "internal" },
  { file: "password-reset-and-account-unlock.md", title: "Password Reset and Account Unlock", classification: "internal" },
  { file: "data-export-requests.md", title: "Data Export Requests", classification: "internal" },
  { file: "retention-offers-and-save-script.md", title: "Retention Offers and the Save-the-Sale Script", classification: "internal" },
  { file: "chargeback-and-dispute-intake.md", title: "Chargeback and Dispute Intake", classification: "internal" },
  { file: "invoices-and-tax-receipts.md", title: "Invoices and Tax Receipts", classification: "internal" },
  { file: "education-and-nonprofit-discounts.md", title: "Education and Nonprofit Discounts", classification: "internal" },
  { file: "accessibility-and-relay-calls.md", title: "Accessibility and Relay Calls", classification: "internal" },
  { file: "deceased-account-holder-requests.md", title: "Deceased Account Holder Requests", classification: "internal" },
  { file: "fraud-team-handoff.md", title: "Fraud Team Handoff", classification: "confidential" }
];

// Titles of the 13 sources already live before this seed.
const T = {
  cancellation: "Cancellation Policy",
  refund: "Refund Procedure",
  refundScreen: "Billing Console: Issue Refund Screen",
  decline: "Payment Decline Codes Quick Reference",
  pricing: "Plans and Pricing Reference",
  identity: "Identity Verification Procedure",
  pinMemo: "Memo PM-2026-14: Account PIN Length Change",
  escalation: "Escalation Matrix",
  poster: "Escalation Path Poster",
  outage: "Outages and Service Credits FAQ",
  holiday: "Holiday Support Hours 2026",
  scripts: "Call Scripts",
  privacy: "Privacy Requests: Data Export and Account Deletion",
  payment: "Updating a Payment Method",
  upgrades: "Plan Upgrades and Proration",
  seats: "Enterprise Seat Management",
  storage: "Storage Limits and Overage",
  twoFactor: "Two-Factor Authentication Reset",
  recovery: "Account Recovery When the Email Is Lost",
  password: "Password Reset and Account Unlock",
  exportReq: "Data Export Requests",
  retention: "Retention Offers and the Save-the-Sale Script",
  chargeback: "Chargeback and Dispute Intake",
  invoices: "Invoices and Tax Receipts",
  discounts: "Education and Nonprofit Discounts",
  accessibility: "Accessibility and Relay Calls",
  deceased: "Deceased Account Holder Requests",
  fraud: "Fraud Team Handoff"
} as const;

type UserKey = "jordan" | "aisha" | "marcus" | "kim" | "tomas" | "devon" | "csr" | "manager";

interface ShowcaseUser {
  key: UserKey;
  name: string;
  email: string;
  /** Answerable, out-of-scope and near-miss question counts for `ask`. */
  asks: { answerable: number; outOfScope: number; nearMiss: number };
  thumbsDownRate: number;
  thumbsUpRate: number;
  views: number;
  /** Days before now the person started; activity is spread from then. */
  activeDays: number;
}

const NEW_CSRS: ShowcaseUser[] = [
  { key: "jordan", name: "Jordan Reyes", email: "jordan.reyes@larkspur.example", asks: { answerable: 44, outOfScope: 2, nearMiss: 4 }, thumbsDownRate: 0.03, thumbsUpRate: 0.18, views: 25, activeDays: 90 },
  { key: "aisha", name: "Aisha Bello", email: "aisha.bello@larkspur.example", asks: { answerable: 21, outOfScope: 9, nearMiss: 5 }, thumbsDownRate: 0.04, thumbsUpRate: 0.12, views: 12, activeDays: 76 },
  { key: "marcus", name: "Marcus Webb", email: "marcus.webb@larkspur.example", asks: { answerable: 30, outOfScope: 2, nearMiss: 3 }, thumbsDownRate: 0.32, thumbsUpRate: 0.04, views: 7, activeDays: 63 },
  { key: "kim", name: "Kim Nguyen", email: "kim.nguyen@larkspur.example", asks: { answerable: 25, outOfScope: 2, nearMiss: 3 }, thumbsDownRate: 0.03, thumbsUpRate: 0.2, views: 16, activeDays: 88 },
  { key: "tomas", name: "Tomas Rivera", email: "tomas.rivera@larkspur.example", asks: { answerable: 8, outOfScope: 1, nearMiss: 1 }, thumbsDownRate: 0.05, thumbsUpRate: 0.1, views: 5, activeDays: 41 },
  { key: "devon", name: "Devon Clarke", email: "devon.clarke@larkspur.example", asks: { answerable: 0, outOfScope: 0, nearMiss: 0 }, thumbsDownRate: 0, thumbsUpRate: 0, views: 9, activeDays: 4 }
];

const DEMO_CSR: ShowcaseUser = {
  key: "csr", name: "CSR", email: "csr@demo.truenote",
  asks: { answerable: 35, outOfScope: 2, nearMiss: 3 }, thumbsDownRate: 0.04, thumbsUpRate: 0.15, views: 18, activeDays: 90
};

// Answerable questions. Weight 2 marks the topics CSRs ask about most.
const ANSWERABLE: Array<[string, number]> = [
  ["What is the cancellation fee for a Pro plan?", 2],
  ["how much does it cost to cancel basic", 2],
  ["Is there a cancellation fee for customers in California?", 2],
  ["Customer signed up in 2021, do they pay a cancellation fee?", 2],
  ["Can an Enterprise team member cancel the account?", 1],
  ["How long do files stay available after cancelling?", 1],
  ["Can a customer cancel while a chargeback is open?", 1],
  ["What are the steps to cancel a subscription?", 2],
  ["enterprise cancellation fee", 1],
  ["Customer is in New York and wants to cancel, is there a fee?", 2],
  ["How long is the refund window?", 2],
  ["How long does a refund take to post to the card?", 2],
  ["Which reason code do I use for a courtesy refund?", 2],
  ["Who has to approve a courtesy refund?", 2],
  ["Can I refund to a different card than the original?", 1],
  ["Customer was charged twice, what reason code do I use?", 1],
  ["Customer forgot to turn off auto-renew, can I refund the renewal?", 2],
  ["Is reason code RF-04 still used?", 1],
  ["customer wants a refund 45 days after the charge", 2],
  ["What is the monthly price of the Pro plan?", 2],
  ["How much is Enterprise per user?", 1],
  ["What is the minimum number of users on Enterprise?", 1],
  ["How much storage does Basic include?", 1],
  ["Does the Pro plan include single sign-on?", 1],
  ["What happens when a customer downgrades their plan?", 1],
  ["Is there a partial refund when a customer downgrades?", 1],
  ["annual price for basic", 1],
  ["How much version history does Pro keep?", 1],
  ["How many factors do I need to verify a caller?", 2],
  ["Can I ask the customer for their CVV?", 2],
  ["How many digits is the account PIN?", 2],
  ["Customer gave me a 4-digit PIN, can I accept it?", 2],
  ["Which verification factors are accepted?", 2],
  ["What do I do if a caller fails verification twice?", 2],
  ["What does decline code D41 mean?", 2],
  ["What should I tell a customer whose card returns D41?", 2],
  ["Can the customer retry after a D05 decline?", 1],
  ["What happens after a renewal payment fails?", 2],
  ["when does the account go read-only after a failed payment", 1],
  ["what does D91 mean", 1],
  ["What does decline code D54 mean?", 1],
  ["How fast do I need to escalate when a customer asks for a supervisor?", 2],
  ["Who handles chargebacks?", 2],
  ["Where do I send a subpoena or police request?", 1],
  ["I think the account was taken over, who do I escalate to?", 1],
  ["What ticket queue is used for duplicate charges?", 1],
  ["Several customers are reporting the same outage, what do I do?", 1],
  ["What credit does an Enterprise customer get if uptime falls below 99.0%?", 2],
  ["What is the Enterprise uptime commitment?", 1],
  ["Do Pro customers get outage credits?", 1],
  ["How long does a customer have to claim an outage credit?", 1],
  ["What is the outage line phone number?", 1],
  ["Can an outage credit be refunded to the card?", 1],
  ["Is support open on December 25?", 2],
  ["Are we open on Thanksgiving?", 1],
  ["Is support open on January 1?", 1],
  ["What must I say when I open a call?", 2],
  ["How long can I leave a caller on hold?", 2],
  ["What is the required closing line?", 1],
  ["How soon do I need to add a note after a call?", 1],
  ["The customer started reading their card number to me, what do I say?", 1],
  ["How long does a data export take?", 1],
  ["When does the export download link expire?", 1],
  ["How long until a deleted account is gone for good?", 1],
  ["Can a customer undo an account deletion?", 1],
  ["A police officer is asking about an account, what do I say?", 1],
  ["How does a customer update the card on file?", 2],
  ["Can I take the new card number over the phone?", 2],
  ["Is PayPal accepted on Enterprise?", 1],
  ["Can an Enterprise customer pay by invoice?", 1],
  ["Customer updated their card after a failed renewal, how do they retry the payment?", 1],
  ["Do we accept prepaid cards?", 1],
  ["How is an upgrade charge calculated?", 2],
  ["When does an upgrade take effect?", 1],
  ["Customer is upgrading from Basic to Pro halfway through the month, how much will they pay?", 1],
  ["When does switching from monthly to annual take effect?", 1],
  ["annual to monthly switch, when does it start", 1],
  ["Why was the customer charged twice after upgrading?", 1],
  ["Who can add seats on an Enterprise account?", 1],
  ["How much does an extra Enterprise seat cost?", 1],
  ["Can an Enterprise customer go below 5 users?", 1],
  ["When does removing an Enterprise seat take effect?", 1],
  ["What happens to a user's files when a seat is removed?", 1],
  ["A team member is asking me to add seats, can I?", 1],
  ["Do we charge overage fees for storage?", 1],
  ["What happens when a customer reaches 100% of their storage?", 1],
  ["Can a customer buy extra storage?", 1],
  ["Do files in Trash count toward storage?", 1],
  ["When does the storage warning email go out?", 1],
  ["Pro customer using 450 GB wants to downgrade to Basic, what happens?", 1],
  ["Customer lost their phone and can't do two-factor, what do I do?", 2],
  ["How long does a 2FA reset take?", 1],
  ["How many backup codes does a customer get for two-factor?", 1],
  ["Can I reset 2FA with the billing ZIP and last 4 of the card?", 1],
  ["Enterprise user needs their 2FA reset", 1],
  ["Customer lost access to their account email, how do I change it?", 2],
  ["How long is the hold on an account email change?", 1],
  ["Customer doesn't know their PIN and lost access to their email", 1],
  ["How long does a mailed recovery code take?", 1],
  ["How long is a password reset link valid?", 1],
  ["How many failed sign-ins lock an account?", 1],
  ["How long does an account lockout last?", 1],
  ["Can I unlock a locked account early?", 1],
  ["Customer didn't get the password reset email", 2],
  ["Can I read the customer their password?", 1],
  ["What's included in a data export?", 1],
  ["Can a customer have two export requests open at once?", 1],
  ["Does the data export include version history?", 1],
  ["Can an Enterprise team member export the whole organization?", 1],
  ["What can I offer a customer who wants to cancel because it's too expensive?", 2],
  ["Can a customer pause their subscription?", 1],
  ["How long can a subscription be paused?", 1],
  ["Can Enterprise plans be paused?", 1],
  ["How many retention offers should I make?", 1],
  ["What is the retention code for a pause?", 1],
  ["Can I refund a charge that's already in a chargeback?", 2],
  ["What's the difference between a billing dispute and a chargeback?", 1],
  ["Which queue do chargebacks go to?", 1],
  ["Customer disputed the charge with their bank and now wants to cancel", 1],
  ["Where can a customer find old invoices?", 1],
  ["Can I add a VAT number to past invoices?", 1],
  ["How far back can an invoice be reissued?", 1],
  ["Do our prices include sales tax?", 1],
  ["Customer is tax exempt, what do they need to do?", 1],
  ["Can I email an invoice to a different address?", 1],
  ["Do we have a student discount?", 1],
  ["What is the nonprofit discount?", 1],
  ["Is the Basic plan eligible for the education discount?", 1],
  ["How long does Billing Operations take to approve a discount?", 1],
  ["What is the Pro monthly price with the education discount?", 1],
  ["Can a government agency get a discount?", 1],
  ["How do I handle a relay call?", 1],
  ["On a relay call do I talk to the operator or the customer?", 1],
  ["Can I verify a customer on a relay call?", 1],
  ["Customer wants large print invoices", 1],
  ["Caller says the account holder passed away, what do I do?", 1],
  ["Is there a cancellation fee when the account holder has died?", 1],
  ["Can a family member get into a deceased customer's files?", 1],
  ["What queue do bereavement requests go to?", 1]
];

// Asked by several people with different casing and punctuation, so the
// question list groups them.
const SHARED: Array<{ variants: string[]; users: UserKey[] }> = [
  { variants: ["What is the cancellation fee for a Pro plan?", "what is the cancellation fee for a pro plan", "What is the cancellation fee for a Pro plan??", "WHAT IS THE CANCELLATION FEE FOR A PRO PLAN"], users: ["jordan", "csr", "marcus", "kim"] },
  { variants: ["How long does a refund take to post to the card?", "how long does a refund take to post to the card", "How long does a refund take to post to the card ?"], users: ["jordan", "aisha", "csr"] },
  { variants: ["What does decline code D41 mean?", "what does decline code d41 mean", "What does decline code D41 mean"], users: ["kim", "marcus", "tomas"] },
  { variants: ["Customer gave me a 4-digit PIN, can I accept it?", "customer gave me a 4-digit pin, can i accept it", "Customer gave me a 4-digit PIN, can I accept it??"], users: ["jordan", "csr", "kim"] },
  { variants: ["Is support open on December 25?", "is support open on december 25", "Is support open on December 25!"], users: ["aisha", "marcus", "csr"] },
  { variants: ["How fast do I need to escalate when a customer asks for a supervisor?", "how fast do i need to escalate when a customer asks for a supervisor"], users: ["jordan", "kim"] },
  { variants: ["Can I refund a charge that's already in a chargeback?", "can I refund a charge that's already in a chargeback"], users: ["marcus", "jordan"] },
  { variants: ["What is the cancellation fee for the Platinum plan?", "what is the cancellation fee for the platinum plan"], users: ["aisha", "csr"] }
];

const OUT_OF_SCOPE: string[] = [
  "What is the cancellation fee for the Platinum plan?",
  "Does Larkspur Cloud offer a moon-rocket plan?",
  "How do I connect Larkspur to Dropbox?",
  "What is our parental leave policy?",
  "How do I request PTO?",
  "What's the wifi password for the office?",
  "Does Larkspur have a data center in Germany?",
  "Which TLS version does the desktop app use?",
  "How do I install the Linux sync client?",
  "What is the referral bonus for customers?",
  "Who is the CEO of Larkspur Cloud?",
  "Is there a family plan?",
  "What is the API rate limit for developers?",
  "How do I file an expense report?",
  "Do we sell gift cards?",
  "What time is the team lunch break?",
  "How much is the late fee on an unpaid invoice?",
  "Can a customer transfer their account to another person?",
  "What is the main support phone number?",
  "Does the iPhone app support Face ID?"
];

const NEAR_MISS: string[] = [
  "What's the cancellation fee for a customer in Texas?",
  "Can a customer pay with Bitcoin?",
  "Can I give a customer 10% off to keep them?",
  "Do Basic customers get phone support?",
  "Is support open on Christmas Eve?",
  "How long are sharing links valid?",
  "Can a Pro customer get a refund for an outage?",
  "Can I extend an expired export link?",
  "Customer wants a refund on an annual plan after 2 months",
  "Can I change the billing address for a customer?",
  "How many users can be on a Basic plan?",
  "What happens to shared links after cancellation?",
  "Can a customer have two accounts with one email?",
  "Customer wants to downgrade from Enterprise to Pro, how?",
  "What does decline code D99 mean?",
  "Can a caller verify with their date of birth?",
  "Customer wants to merge two accounts",
  "Does the Pro plan include an admin console?",
  "How long do we keep call recordings?",
  "What is the priority for card testing?"
];

// Relative popularity of sources for reader opens.
const VIEW_WEIGHTS: Record<string, number> = {
  [T.cancellation]: 9, [T.identity]: 8, [T.escalation]: 7, [T.refund]: 7, [T.decline]: 6,
  [T.pricing]: 5, [T.scripts]: 5, [T.retention]: 4, [T.payment]: 4, [T.upgrades]: 3,
  [T.pinMemo]: 3, [T.outage]: 3, [T.twoFactor]: 3, [T.password]: 3, [T.refundScreen]: 2,
  [T.holiday]: 2, [T.privacy]: 2, [T.chargeback]: 2, [T.storage]: 2, [T.recovery]: 2,
  [T.seats]: 1, [T.exportReq]: 1, [T.invoices]: 1, [T.discounts]: 1, [T.poster]: 1,
  [T.accessibility]: 1, [T.deceased]: 1
};

interface FolderSpec {
  name: string;
  color?: string;
  children?: string[];
}

const FOLDERS: FolderSpec[] = [
  { name: "Billing", color: "blue", children: ["Refunds", "Fees", "Payments"] },
  { name: "Account security", color: "red", children: ["Identity verification", "Passwords and 2FA"] },
  { name: "Plans and service", color: "green" },
  { name: "Retention", color: "amber" },
  { name: "Escalations", color: "violet" },
  { name: "Privacy and data", color: "teal" }
];

// Folder paths per source ("Parent/Child" or top-level name). Three sources
// stay in no folder: Holiday Support Hours, Call Scripts, Accessibility.
const MEMBERSHIP: Record<string, string[]> = {
  [T.cancellation]: ["Billing/Fees", "Retention"],
  [T.refund]: ["Billing/Refunds"],
  [T.refundScreen]: ["Billing/Refunds"],
  [T.decline]: ["Billing/Payments"],
  [T.pricing]: ["Plans and service"],
  [T.identity]: ["Account security/Identity verification"],
  [T.pinMemo]: ["Account security/Identity verification"],
  [T.escalation]: ["Escalations"],
  [T.poster]: ["Escalations"],
  [T.outage]: ["Plans and service"],
  [T.privacy]: ["Privacy and data"],
  [T.payment]: ["Billing/Payments"],
  [T.upgrades]: ["Plans and service", "Billing/Fees"],
  [T.seats]: ["Plans and service"],
  [T.storage]: ["Plans and service"],
  [T.twoFactor]: ["Account security/Passwords and 2FA"],
  [T.recovery]: ["Account security/Identity verification", "Account security/Passwords and 2FA"],
  [T.password]: ["Account security/Passwords and 2FA"],
  [T.exportReq]: ["Privacy and data"],
  [T.retention]: ["Retention"],
  [T.chargeback]: ["Billing", "Escalations"],
  [T.invoices]: ["Billing/Payments"],
  [T.discounts]: ["Billing/Fees"],
  [T.deceased]: ["Privacy and data"],
  [T.fraud]: ["Escalations"],
  [T.holiday]: [],
  [T.scripts]: [],
  [T.accessibility]: []
};

const TAGS: Array<{ name: string; color: string }> = [
  { name: "Policy", color: "blue" },
  { name: "Script", color: "green" },
  { name: "Quick reference", color: "amber" },
  { name: "Procedure", color: "slate" }
];

const TAGGING: Record<string, string[]> = {
  [T.cancellation]: ["Policy"],
  [T.refund]: ["Procedure"],
  [T.refundScreen]: ["Quick reference"],
  [T.decline]: ["Quick reference"],
  [T.pricing]: ["Quick reference"],
  [T.identity]: ["Procedure", "Policy"],
  [T.pinMemo]: ["Policy"],
  [T.escalation]: ["Quick reference"],
  [T.poster]: ["Quick reference"],
  [T.outage]: ["Quick reference"],
  [T.holiday]: ["Quick reference"],
  [T.scripts]: ["Script"],
  [T.privacy]: ["Procedure"],
  [T.payment]: ["Procedure"],
  [T.upgrades]: ["Procedure"],
  [T.seats]: ["Procedure"],
  [T.storage]: ["Quick reference"],
  [T.twoFactor]: ["Procedure"],
  [T.recovery]: ["Procedure"],
  [T.password]: ["Procedure"],
  [T.exportReq]: ["Procedure"],
  [T.retention]: ["Script", "Policy"],
  [T.chargeback]: ["Procedure"],
  [T.invoices]: ["Quick reference"],
  [T.discounts]: ["Policy"],
  [T.accessibility]: ["Procedure"],
  [T.deceased]: ["Procedure"],
  [T.fraud]: ["Procedure"]
};

const TEAM_PINS = [T.cancellation, T.identity, T.escalation];

interface PersonalSpec {
  pins: string[];
  notes: Array<[string, string]>;
  colors: Array<[string, string]>;
  labels: Array<[string, string]>;
}

const NOTE_TEXT: Record<string, string> = {
  [T.cancellation]: "Check the state before quoting a fee. California and New York pay nothing, and anyone who joined before January 1, 2022 pays nothing.",
  [T.refund]: "RF-05 needs the Tier 2 approval ID before the console lets you submit. Get it before you promise anything.",
  [T.identity]: "4-digit PINs stopped working October 1. Ask for the 6-digit PIN or send the one-time code.",
  [T.decline]: "D41: never say lost or stolen. Just ask for a different card and do not retry.",
  [T.escalation]: "Supervisor request = warm transfer within 15 minutes. Don't try to talk them out of it.",
  [T.upgrades]: "Read the prorated amount from the console before submitting. Customers call back about the second charge otherwise.",
  [T.retention]: "One offer only. If they say just cancel it, cancel it.",
  [T.storage]: "There is no add-on storage. Offer emptying Trash first, then the next plan up.",
  [T.outage]: "Outage credits go through Credits > Outage credit, never Issue Refund.",
  [T.scripts]: "Opening and closing lines are word for word. QA scores them.",
  [T.twoFactor]: "Ask about backup codes first. Half the time they still have them."
};

const PERSONAL: Partial<Record<UserKey, PersonalSpec>> = {
  csr: {
    pins: [T.cancellation, T.refund, T.decline, T.scripts, T.holiday],
    notes: [[T.cancellation, NOTE_TEXT[T.cancellation]!], [T.decline, NOTE_TEXT[T.decline]!], [T.scripts, NOTE_TEXT[T.scripts]!]],
    colors: [[T.cancellation, "red"], [T.pricing, "red"], [T.pinMemo, "amber"], [T.scripts, "green"]],
    labels: [["red", "Read before quoting fees"], ["green", "Easy wins"], ["amber", "Changes often"]]
  },
  manager: {
    pins: [T.escalation, T.retention, T.outage, T.chargeback],
    notes: [[T.escalation, NOTE_TEXT[T.escalation]!], [T.retention, NOTE_TEXT[T.retention]!]],
    colors: [[T.escalation, "blue"], [T.chargeback, "blue"], [T.holiday, "amber"]],
    labels: [["blue", "Escalation paths"], ["amber", "Changes often"], ["red", "Read before quoting fees"]]
  },
  jordan: {
    pins: [T.cancellation, T.identity, T.upgrades, T.refund, T.payment, T.twoFactor, T.escalation],
    notes: [[T.refund, NOTE_TEXT[T.refund]!], [T.upgrades, NOTE_TEXT[T.upgrades]!], [T.twoFactor, NOTE_TEXT[T.twoFactor]!], [T.identity, NOTE_TEXT[T.identity]!]],
    colors: [[T.cancellation, "red"], [T.upgrades, "red"], [T.scripts, "green"], [T.holiday, "amber"]],
    labels: [["red", "Read before quoting fees"], ["green", "Easy wins"], ["amber", "Changes often"]]
  },
  kim: {
    pins: [T.identity, T.pinMemo, T.decline, T.storage],
    notes: [[T.identity, NOTE_TEXT[T.identity]!], [T.storage, NOTE_TEXT[T.storage]!]],
    colors: [[T.pinMemo, "amber"], [T.storage, "green"], [T.password, "green"]],
    labels: [["green", "Easy wins"], ["amber", "Changes often"], ["violet", "Security"]]
  },
  aisha: {
    pins: [T.outage, T.privacy, T.exportReq, T.holiday, T.scripts],
    notes: [[T.outage, NOTE_TEXT[T.outage]!], [T.scripts, NOTE_TEXT[T.scripts]!]],
    colors: [[T.privacy, "teal"], [T.exportReq, "teal"], [T.holiday, "amber"]],
    labels: [["teal", "Privacy questions"], ["amber", "Changes often"], ["green", "Easy wins"]]
  }
};

// ---------------------------------------------------------------------------
// State, secrets, RNG

interface AskRecord {
  user: UserKey;
  userId: string;
  queryLogId: string | null;
  sessionId: string | null;
  question: string;
  kind: "answerable" | "out_of_scope" | "near_miss";
  refused: boolean;
  cited: Array<{ documentId: string; versionId: string; index: number }>;
  feedback: 1 | -1 | null;
  at: string;
}

interface ViewRecord {
  user: UserKey;
  userId: string;
  documentId: string;
  via: "browse" | "citation";
  queryLogId: string | null;
  at: string;
}

interface SeedState {
  programId: string;
  agentUserId?: string;
  documents?: Record<string, string>;
  users?: Partial<Record<UserKey, { id: string; email: string; name: string; created: boolean }>>;
  askStep?: { start: string; end: string };
  asks?: AskRecord[];
  viewStep?: { start: string; end: string };
  views?: ViewRecord[];
  backdatedAt?: string;
}

function loadState(): SeedState {
  if (!existsSync(STATE_PATH)) return { programId: PROGRAM_ID };
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as SeedState;
}

function saveState(state: SeedState): void {
  mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readJson<V>(file: string): V {
  return JSON.parse(readFileSync(file, "utf8")) as V;
}

function agentCredentials(): { email: string; password: string } {
  const j = readJson<{ email: string; password: string }>(AGENT_SECRETS);
  return { email: j.email, password: j.password };
}

function csrSecrets(): Record<string, string> {
  return existsSync(CSR_SECRETS) ? readJson<Record<string, string>>(CSR_SECRETS) : {};
}

function writeCsrSecrets(value: Record<string, string>): void {
  mkdirSync(SECRETS_DIR, { recursive: true });
  writeFileSync(CSR_SECRETS, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform === "win32") {
    // Owner-only ACL: drop inherited entries and grant the current user alone.
    spawnSync("icacls", [CSR_SECRETS, "/inheritance:r", "/grant:r", `${os.userInfo().username}:F`], {
      stdio: "ignore"
    });
  }
}

function strongPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** mulberry32: deterministic choices, so a re-run picks the same layout. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(label: string): number {
  return createHash("sha256").update(label).digest().readUInt32LE(0);
}

function shuffle<V>(items: V[], rand: () => number): V[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function weightedSample<V>(items: Array<[V, number]>, count: number, rand: () => number): V[] {
  const pool = [...items];
  const picked: V[] = [];
  while (picked.length < count && pool.length > 0) {
    const total = pool.reduce((sum, [, w]) => sum + w, 0);
    let r = rand() * total;
    let index = 0;
    for (; index < pool.length - 1; index++) {
      r -= pool[index]![1];
      if (r <= 0) break;
    }
    picked.push(pool[index]![0]);
    pool.splice(index, 1);
  }
  return picked;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The server's clock, from the Date header. This machine's clock can drift
 * minutes from the database's (4.5 minutes on 2026-10-08), and the view
 * window and "never in the future" checks compare against database times.
 */
async function serverNow(): Promise<number> {
  const res = await fetch(`${BASE}/health`);
  const header = res.headers.get("date");
  await res.text();
  const t = header ? Date.parse(header) : NaN;
  if (!Number.isFinite(t)) throw new Error("server sent no Date header");
  return t;
}

// ---------------------------------------------------------------------------
// HTTP client

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

class Api {
  private cookie: string | null = null;
  constructor(readonly label: string) {}

  async call<R = any>(
    method: string,
    url: string,
    options: { body?: unknown; form?: FormData; program?: boolean; allow?: number[] } = {}
  ): Promise<{ status: number; json: R; headers: Headers }> {
    const headers: Record<string, string> = { Origin: BASE };
    if (this.cookie) headers["Cookie"] = this.cookie;
    if (options.program !== false) headers["X-Program-Id"] = PROGRAM_ID;
    let payload: RequestInit["body"];
    if (options.form) payload = options.form;
    else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: "manual" });
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq > 0 && pair.slice(eq + 1).trim() !== "") this.cookie = pair;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    if (!res.ok && !(options.allow ?? []).includes(res.status)) {
      // Never echo request bodies: they can hold passwords.
      throw new ApiError(
        `${this.label}: ${method} ${url} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`,
        res.status,
        json
      );
    }
    return { status: res.status, json: json as R, headers: res.headers };
  }

  async login(email: string, password: string): Promise<{ id: string; role: string; mustResetPassword: boolean }> {
    const r = await this.call("POST", "/api/auth/login", { body: { email, password }, program: false });
    return r.json.user;
  }

  async logout(): Promise<void> {
    if (!this.cookie) return;
    await this.call("POST", "/api/auth/logout", { program: false, allow: [401] });
    this.cookie = null;
  }
}

async function asAgent<R>(fn: (api: Api) => Promise<R>): Promise<R> {
  const api = new Api("agent");
  const { email, password } = agentCredentials();
  await api.login(email, password);
  try {
    return await fn(api);
  } finally {
    await api.logout();
  }
}

interface DemoAccount {
  email: string;
  password: string;
  role: string;
}

async function demoAccounts(): Promise<DemoAccount[]> {
  const r = await new Api("config").call<{ demoAccounts?: DemoAccount[] }>("GET", "/api/config", { program: false });
  return r.json.demoAccounts ?? [];
}

/** Credentials for a seeded or demo user, without printing them. */
async function credentialsFor(user: ShowcaseUser | { key: UserKey; email: string }): Promise<string> {
  if (user.key === "csr" || user.key === "manager") {
    const match = (await demoAccounts()).find((a) => a.email.toLowerCase() === user.email);
    if (!match) throw new Error(`demo account ${user.email} is not published on /api/config`);
    return match.password;
  }
  const secret = csrSecrets()[user.email];
  if (!secret) throw new Error(`no credentials for ${user.email} in ${CSR_SECRETS}`);
  return secret;
}

async function loginAs(user: ShowcaseUser | { key: UserKey; email: string }): Promise<{ api: Api; id: string }> {
  const api = new Api(user.key);
  const me = await api.login(user.email, await credentialsFor(user));
  if (me.mustResetPassword) throw new Error(`${user.email} still has to change its password; run the users step`);
  return { api, id: me.id };
}

interface KbList {
  items: Array<{
    documentId: string;
    title: string;
    pinnedAt: string | null;
    note: string | null;
    myColor: string | null;
    lastViewedByMeAt: string | null;
    featuredPosition: number | null;
    categoryIds: string[];
    tagIds: string[];
    viewCount: number;
    citationCount: number;
  }>;
  categories: Array<{ id: string; parentId: string | null; name: string; color: string; documentIds?: string[] }>;
  tags: Array<{ id: string; name: string; color: string }>;
  labels: Array<{ color: string; name: string }>;
  canOrganize: boolean;
}

async function kbList(api: Api): Promise<KbList> {
  return (await api.call<KbList>("GET", "/api/kb/documents")).json;
}

function docIdsByTitle(list: KbList): Map<string, string> {
  return new Map(list.items.map((i) => [i.title, i.documentId]));
}

// ---------------------------------------------------------------------------
// Steps

async function stepUpload(state: SeedState): Promise<void> {
  await asAgent(async (api) => {
    const docs = await api.call<{
      items: Array<{ title: string; lifecycleState: string; parseStatus: string | null; isActive: boolean; versionId: string | null }>;
      sources: Array<{ id: string; name: string }>;
    }>("GET", "/api/documents");
    const source = docs.json.sources.find((s) => s.name === "Manual administrator upload") ?? docs.json.sources[0];
    if (!source) throw new Error("no approved content source in the Demo Program");
    const existing = new Set(docs.json.items.map((i) => i.title));
    const pending: string[] = [];
    for (const f of SHOWCASE_FILES) {
      if (existing.has(f.title)) {
        console.log(`upload: skip "${f.title}" (exists)`);
        continue;
      }
      const bytes = readFileSync(path.join(FILES_DIR, f.file));
      let classification: string = f.classification;
      for (;;) {
        const form = new FormData();
        form.append("title", f.title);
        form.append("sourceId", source.id);
        form.append("classification", classification);
        form.append("file", new Blob([bytes], { type: "text/markdown" }), f.file);
        const r = await api.call("POST", "/api/documents/upload", { form, allow: [403] });
        if (r.status === 403 && classification === "confidential") {
          console.log(`upload: "${f.title}" refused as confidential (${JSON.stringify(r.json)}); uploading as internal`);
          classification = "internal";
          continue;
        }
        if (r.status !== 200) throw new Error(`upload ${f.title}: ${r.status} ${JSON.stringify(r.json)}`);
        console.log(`upload: "${f.title}" as ${classification} -> version ${r.json.documentVersionId}`);
        pending.push(f.title);
        break;
      }
      await sleep(1500);
    }
    const deadline = Date.now() + 20 * 60_000;
    for (;;) {
      const now = await api.call<{ items: Array<{ title: string; lifecycleState: string; parseStatus: string | null; isActive: boolean; documentId: string }> }>("GET", "/api/documents");
      const rows = SHOWCASE_FILES.map((f) => now.json.items.find((i) => i.title === f.title));
      const bad = rows.filter((r) => r && ["failed", "quarantined", "rejected", "revoked"].includes(r.lifecycleState));
      if (bad.length > 0) throw new Error(`ingestion problem: ${bad.map((b) => `${b!.title}=${b!.lifecycleState}/${b!.parseStatus}`).join(", ")}`);
      const notLive = rows.filter((r) => !r || !(r.lifecycleState === "active" && r.parseStatus === "ready" && r.isActive));
      console.log(`upload: ${rows.length - notLive.length}/${rows.length} live`);
      if (notLive.length === 0) {
        state.documents = Object.fromEntries(rows.map((r) => [r!.title, r!.documentId]));
        break;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${notLive.map((r, i) => r?.title ?? SHOWCASE_FILES[i]?.title).join(", ")}`);
      await sleep(15_000);
    }
    const list = await kbList(api);
    state.documents = Object.fromEntries(list.items.map((i) => [i.title, i.documentId]));
    console.log(`upload: library lists ${list.items.length} sources for the agent`);
  });
  saveState(state);
}

async function stepUsers(state: SeedState): Promise<void> {
  const secrets = csrSecrets();
  state.users ??= {};
  await asAgent(async (api) => {
    const existing = (await api.call<{ items: Array<{ id: string; email: string; mustResetPassword: boolean }> }>("GET", "/api/admin/users")).json.items;
    for (const u of NEW_CSRS) {
      const found = existing.find((e) => e.email === u.email);
      if (found) {
        if (!secrets[u.email]) throw new Error(`${u.email} exists but has no credentials in ${CSR_SECRETS}`);
        state.users![u.key] = { id: found.id, email: u.email, name: u.name, created: state.users![u.key]?.created ?? false };
        console.log(`users: ${u.email} exists`);
        continue;
      }
      const temporary = strongPassword();
      const r = await api.call<{ item: { id: string } }>("POST", "/api/admin/users", {
        body: { email: u.email, name: u.name, role: "csr", programId: PROGRAM_ID, password: temporary },
        program: false
      });
      // Record the temporary password first, so a failure below never strands the account.
      secrets[u.email] = temporary;
      writeCsrSecrets(secrets);
      state.users![u.key] = { id: r.json.item.id, email: u.email, name: u.name, created: true };
      saveState(state);
      console.log(`users: created ${u.name} <${u.email}>`);
    }
  });
  // Forced first-login password change, through the API.
  for (const u of NEW_CSRS) {
    const api = new Api(u.key);
    const current = secrets[u.email]!;
    const me = await api.login(u.email, current);
    if (me.mustResetPassword) {
      const next = strongPassword();
      await api.call("POST", "/api/auth/change-password", { body: { currentPassword: current, newPassword: next }, program: false });
      secrets[u.email] = next;
      writeCsrSecrets(secrets);
      console.log(`users: ${u.email} changed its temporary password`);
    }
    await api.logout();
  }
  saveState(state);
}

async function stepOrganize(state: SeedState): Promise<void> {
  await asAgent(async (api) => {
    let list = await kbList(api);
    if (!list.canOrganize) throw new Error("agent cannot organize the library");
    const ids = docIdsByTitle(list);
    for (const title of Object.keys(MEMBERSHIP)) {
      if (!ids.has(title)) throw new Error(`source "${title}" is not live`);
    }
    const folderIds = new Map<string, string>();
    const findFolder = (name: string, parentId: string | null) =>
      list.categories.find((c) => c.name.toLowerCase() === name.toLowerCase() && (c.parentId ?? null) === parentId);
    for (const top of FOLDERS) {
      let parent = findFolder(top.name, null);
      if (!parent) {
        const r = await api.call<{ item: { id: string } }>("POST", "/api/kb/library/categories", { body: { name: top.name, color: top.color } });
        console.log(`organize: folder ${top.name}`);
        list = await kbList(api);
        parent = findFolder(top.name, null) ?? { id: r.json.item.id, parentId: null, name: top.name, color: top.color ?? "slate" };
      } else if (top.color && parent.color !== top.color) {
        await api.call("PATCH", `/api/kb/library/categories/${parent.id}`, { body: { color: top.color } });
      }
      folderIds.set(top.name, parent.id);
      for (const child of top.children ?? []) {
        let node = findFolder(child, parent.id);
        if (!node) {
          await api.call("POST", "/api/kb/library/categories", { body: { name: child, parentId: parent.id } });
          console.log(`organize: folder ${top.name}/${child}`);
          list = await kbList(api);
          node = findFolder(child, parent.id);
        }
        if (!node) throw new Error(`folder ${top.name}/${child} missing after create`);
        folderIds.set(`${top.name}/${child}`, node.id);
      }
    }
    const tagIds = new Map<string, string>();
    for (const tag of TAGS) {
      let found = list.tags.find((t) => t.name.toLowerCase() === tag.name.toLowerCase());
      if (!found) {
        const r = await api.call<{ item: { id: string } }>("POST", "/api/kb/library/tags", { body: tag });
        found = { id: r.json.item.id, name: tag.name, color: tag.color };
        console.log(`organize: tag ${tag.name}`);
      }
      tagIds.set(tag.name, found.id);
    }
    for (const [title, paths] of Object.entries(MEMBERSHIP)) {
      const categoryIds = paths.map((p) => {
        const id = folderIds.get(p);
        if (!id) throw new Error(`unknown folder ${p}`);
        return id;
      });
      await api.call("PUT", `/api/kb/library/documents/${ids.get(title)}/categories`, { body: { categoryIds } });
      const tags = (TAGGING[title] ?? []).map((n) => tagIds.get(n)!);
      await api.call("PUT", `/api/kb/library/documents/${ids.get(title)}/tags`, { body: { tagIds: tags } });
    }
    console.log(`organize: memberships and tags set on ${Object.keys(MEMBERSHIP).length} sources`);
    await api.call("PUT", "/api/kb/library/featured", { body: { documentIds: TEAM_PINS.map((t) => ids.get(t)!) } });
    console.log(`organize: team pins ${TEAM_PINS.join(", ")}`);
    state.documents = Object.fromEntries(ids);
  });
  saveState(state);
}

interface AskPlanItem {
  user: ShowcaseUser;
  question: string;
  kind: AskRecord["kind"];
}

function buildAskPlan(): AskPlanItem[] {
  const askers = [...NEW_CSRS.filter((u) => u.key !== "devon"), DEMO_CSR];
  const plan: AskPlanItem[] = [];
  for (const u of askers) {
    const rand = rng(seedFor(`ask:${u.key}`));
    const shared = SHARED.filter((s) => s.users.includes(u.key)).map((s) => {
      const variant = s.variants[s.users.indexOf(u.key) % s.variants.length]!;
      return { question: variant, kind: OUT_OF_SCOPE.includes(s.variants[0]!) ? ("out_of_scope" as const) : ("answerable" as const) };
    });
    const sharedAnswerable = shared.filter((s) => s.kind === "answerable");
    const sharedOos = shared.filter((s) => s.kind === "out_of_scope");
    const sharedBase = new Set(SHARED.flatMap((s) => s.variants.map((v) => v.toLowerCase())));
    const answerablePool = ANSWERABLE.filter(([q]) => !sharedBase.has(q.toLowerCase()));
    const own = weightedSample(answerablePool, u.asks.answerable - sharedAnswerable.length, rand).map((q) => ({ question: q, kind: "answerable" as const }));
    const oosPool = OUT_OF_SCOPE.filter((q) => !sharedBase.has(q.toLowerCase()));
    const oos = shuffle(oosPool, rand).slice(0, u.asks.outOfScope - sharedOos.length).map((q) => ({ question: q, kind: "out_of_scope" as const }));
    const near = shuffle(NEAR_MISS, rand).slice(0, u.asks.nearMiss).map((q) => ({ question: q, kind: "near_miss" as const }));
    for (const item of shuffle([...sharedAnswerable, ...sharedOos, ...own, ...oos, ...near], rand)) {
      plan.push({ user: u, ...item });
    }
  }
  // Interleave people so no one asks in a long burst.
  const queues = new Map<UserKey, AskPlanItem[]>();
  for (const item of plan) {
    const q = queues.get(item.user.key) ?? [];
    q.push(item);
    queues.set(item.user.key, q);
  }
  const rand = rng(seedFor("ask:interleave"));
  const ordered: AskPlanItem[] = [];
  while (ordered.length < plan.length) {
    const live = [...queues.entries()].filter(([, q]) => q.length > 0);
    const total = live.reduce((s, [, q]) => s + q.length, 0);
    let r = rand() * total;
    let pick = live[0]!;
    for (const entry of live) {
      r -= entry[1].length;
      if (r <= 0) {
        pick = entry;
        break;
      }
    }
    ordered.push(pick[1].shift()!);
  }
  return ordered;
}

interface AskResponseBody {
  queryLogId: string | null;
  sessionId: string | null;
  refused: boolean;
  sources: Array<{ doc_id: string | null; document_version_id: string | null; citation_index: number }>;
}

async function stepAsk(state: SeedState): Promise<void> {
  if ((state.asks?.length ?? 0) > 0 && !process.argv.includes("--again")) {
    throw new Error(`state already holds ${state.asks!.length} asks; pass --again to add more rows`);
  }
  const plan = buildAskPlan();
  const counts = new Map<string, number>();
  for (const p of plan) counts.set(p.user.key, (counts.get(p.user.key) ?? 0) + 1);
  console.log(`ask: ${plan.length} questions planned (${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")})`);
  const sessions = new Map<UserKey, { api: Api; id: string; lastSession: string | null }>();
  state.asks ??= [];
  state.askStep = { start: new Date().toISOString(), end: "" };
  saveState(state);
  const feedbackRand = rng(seedFor("ask:feedback"));
  const sessionRand = rng(seedFor("ask:sessions"));
  let deadlineRefusals = 0;
  try {
    for (const user of [...NEW_CSRS.filter((u) => u.key !== "devon"), DEMO_CSR]) {
      const s = await loginAs(user);
      sessions.set(user.key, { ...s, lastSession: null });
      state.users ??= {};
      state.users[user.key] ??= { id: s.id, email: user.email, name: user.name, created: false };
    }
    let lastStart = 0;
    for (const [i, item] of plan.entries()) {
      const wait = lastStart + ASK_SPACING_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      const who = sessions.get(item.user.key)!;
      // About 1 in 7 questions continue the person's previous call.
      const sessionId = who.lastSession && sessionRand() < 0.15 ? who.lastSession : undefined;
      let r: { status: number; json: AskResponseBody; headers: Headers };
      for (let attempt = 0; ; attempt++) {
        r = await who.api.call<AskResponseBody>("POST", "/api/ask", {
          body: sessionId ? { question: item.question, sessionId } : { question: item.question },
          allow: [429]
        });
        if (r.status !== 429) break;
        if (attempt >= 2) throw new Error(`ask rate-limited three times for ${item.user.key}`);
        await sleep(Number(r.headers.get("retry-after") ?? "20") * 1000);
      }
      const body = r.json;
      if (!body.queryLogId) deadlineRefusals++;
      who.lastSession = body.sessionId ?? who.lastSession;
      const cited = (body.sources ?? [])
        .filter((s) => s.doc_id && s.document_version_id)
        .map((s) => ({ documentId: s.doc_id!.toLowerCase(), versionId: s.document_version_id!, index: s.citation_index }));
      const answered = !body.refused && cited.length > 0;
      let feedback: 1 | -1 | null = null;
      if (answered && body.queryLogId) {
        const roll = feedbackRand();
        if (roll < item.user.thumbsDownRate) feedback = -1;
        else if (roll < item.user.thumbsDownRate + item.user.thumbsUpRate) feedback = 1;
        if (feedback !== null) {
          await who.api.call("POST", "/api/feedback", { body: { queryLogId: body.queryLogId, feedback } });
        }
      }
      state.asks.push({
        user: item.user.key,
        userId: who.id,
        queryLogId: body.queryLogId,
        sessionId: body.sessionId,
        question: item.question,
        kind: item.kind,
        refused: body.refused,
        cited,
        feedback,
        at: new Date().toISOString()
      });
      saveState(state);
      console.log(
        `ask ${i + 1}/${plan.length} ${item.user.key} [${item.kind}] ${answered ? "answered" : "refused"}${feedback === 1 ? " +1" : feedback === -1 ? " -1" : ""}${sessionId ? " (same call)" : ""}: ${item.question}`
      );
      if (deadlineRefusals > 5) throw new Error("more than 5 asks hit the deadline without a query log row; stopping");
    }
  } finally {
    state.askStep.end = new Date().toISOString();
    saveState(state);
    for (const s of sessions.values()) await s.api.logout();
  }
}

async function stepViews(state: SeedState): Promise<void> {
  state.views ??= [];
  state.viewStep = { start: new Date(await serverNow()).toISOString(), end: "" };
  saveState(state);
  try {
    for (const user of [...NEW_CSRS, DEMO_CSR]) {
      const { api, id } = await loginAs(user);
      try {
        const rand = rng(seedFor(`views:${user.key}`));
        const list = await kbList(api);
        const visible = new Map(list.items.map((i) => [i.documentId, i.title]));
        const opened = new Set<string>();
        const targets: Array<{ documentId: string; via: "browse" | "citation"; url: string; queryLogId: string | null }> = [];
        // About a third of opens come from the person's own cited answers.
        const ownCites = (state.asks ?? []).filter((a) => a.user === user.key && a.queryLogId && a.cited.length > 0);
        for (const a of shuffle(ownCites, rand)) {
          if (targets.length >= Math.round(user.views * 0.35)) break;
          const c = a.cited[0]!;
          if (opened.has(c.documentId) || !visible.has(c.documentId)) continue;
          opened.add(c.documentId);
          targets.push({
            documentId: c.documentId,
            via: "citation",
            queryLogId: a.queryLogId,
            url: `/api/kb/documents/${c.documentId}?version=${c.versionId}&query=${a.queryLogId}&source=${c.index}`
          });
        }
        const weighted = list.items
          .filter((i) => !opened.has(i.documentId))
          .map((i): [string, number] => [i.documentId, VIEW_WEIGHTS[i.title] ?? 1]);
        for (const docId of weightedSample(weighted, user.views - targets.length, rand)) {
          targets.push({ documentId: docId, via: "browse", queryLogId: null, url: `/api/kb/documents/${docId}` });
        }
        for (const t of targets) {
          await api.call("GET", t.url);
          await sleep(400);
        }
        // Views are recorded after the response; confirm each one landed.
        await sleep(1500);
        const after = await kbList(api);
        const since = Date.parse(state.viewStep.start);
        let confirmed = 0;
        for (const t of targets) {
          const row = after.items.find((i) => i.documentId === t.documentId);
          const at = row?.lastViewedByMeAt ? Date.parse(row.lastViewedByMeAt) : 0;
          if (at >= since) {
            state.views.push({ user: user.key, userId: id, documentId: t.documentId, via: t.via, queryLogId: t.queryLogId, at: row!.lastViewedByMeAt! });
            confirmed++;
          }
        }
        saveState(state);
        console.log(`views: ${user.key} opened ${targets.length}, recorded ${confirmed} (${targets.filter((t) => t.via === "citation").length} from citations)`);
      } finally {
        await api.logout();
      }
    }
  } finally {
    state.viewStep.end = new Date(await serverNow()).toISOString();
    saveState(state);
  }
}

async function stepPersonal(): Promise<void> {
  const manager: ShowcaseUser = { ...DEMO_CSR, key: "manager", name: "Manager", email: "manager@demo.truenote" };
  const people: ShowcaseUser[] = [DEMO_CSR, manager, ...NEW_CSRS.filter((u) => PERSONAL[u.key])];
  for (const user of people) {
    const spec = PERSONAL[user.key];
    if (!spec) continue;
    const { api } = await loginAs(user);
    try {
      const list = await kbList(api);
      const byTitle = new Map(list.items.map((i) => [i.title, i]));
      let pins = 0;
      let notes = 0;
      let colors = 0;
      let labels = 0;
      for (const title of spec.pins) {
        const item = byTitle.get(title);
        if (!item || item.pinnedAt) continue;
        await api.call("PUT", `/api/kb/documents/${item.documentId}/pin`, { body: { pinned: true } });
        pins++;
      }
      for (const [title, note] of spec.notes) {
        const item = byTitle.get(title);
        if (!item || item.note) continue;
        await api.call("PUT", `/api/kb/documents/${item.documentId}/note`, { body: { note } });
        notes++;
      }
      for (const [title, color] of spec.colors) {
        const item = byTitle.get(title);
        if (!item || item.myColor) continue;
        await api.call("PUT", `/api/kb/documents/${item.documentId}/color`, { body: { color } });
        colors++;
      }
      for (const [color, name] of spec.labels) {
        if (list.labels.some((l) => l.color === color)) continue;
        await api.call("PUT", `/api/kb/labels/${color}`, { body: { name } });
        labels++;
      }
      console.log(`personal: ${user.key} +${pins} shortcuts, +${notes} notes, +${colors} source colors, +${labels} color names`);
    } finally {
      await api.logout();
    }
  }
}

// --- backdate ---------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Times spread over `days` before now, denser in recent weeks, sorted ascending. */
function spreadTimes(count: number, days: number, rand: () => number, now: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    for (;;) {
      const dayOffset = Math.floor(days * Math.pow(rand(), 1.6));
      const dayStart = Math.floor((now - dayOffset * DAY_MS) / DAY_MS) * DAY_MS;
      // 13:00 to 23:30 UTC = 9:00 to 19:30 Eastern, a day shift.
      const t = dayStart + 13 * 3_600_000 + Math.floor(rand() * 10.5 * 3_600_000);
      if (t < now - 15 * 60_000) {
        out.push(t);
        break;
      }
    }
  }
  return out.sort((a, b) => a - b);
}

function buildBackdateSql(state: SeedState, now: number): { sql: string; expected: Record<string, number> } {
  const users = [...NEW_CSRS, DEMO_CSR];
  const queryRows: Array<[string, string, number]> = [];
  const sessionRows = new Map<string, { userId: string; min: number; max: number }>();
  const viewRows: Array<[string, string, number]> = [];
  const userRows: Array<[string, number]> = [];
  const askTime = new Map<string, number>();
  for (const user of users) {
    const rand = rng(seedFor(`backdate:${user.key}`));
    const asks = (state.asks ?? []).filter((a) => a.user === user.key && a.queryLogId);
    // One time per call (chat session); follow-ups keep their real gap.
    const calls: AskRecord[][] = [];
    const bySession = new Map<string, AskRecord[]>();
    for (const a of asks) {
      const key = a.sessionId ?? a.queryLogId!;
      let call = bySession.get(key);
      if (!call) {
        call = [];
        bySession.set(key, call);
        calls.push(call);
      }
      call.push(a);
    }
    const starts = spreadTimes(calls.length, user.activeDays, rand, now - 10 * 60_000);
    calls.forEach((call, i) => {
      const first = Date.parse(call[0]!.at);
      for (const a of call) {
        const gap = Math.min(Math.max(Date.parse(a.at) - first, a === call[0] ? 0 : 45_000), 6 * 60_000);
        const t = starts[i]! + gap;
        queryRows.push([a.queryLogId!, a.userId, t]);
        askTime.set(a.queryLogId!, t);
        if (a.sessionId) {
          const s = sessionRows.get(a.sessionId) ?? { userId: a.userId, min: t, max: t };
          s.min = Math.min(s.min, t);
          s.max = Math.max(s.max, t);
          sessionRows.set(a.sessionId, s);
        }
      }
    });
    // A question that hit the ask deadline wrote no query_log row but did
    // open a chat session; give that session a time in the same spread.
    const orphanSessions = (state.asks ?? []).filter(
      (a) => a.user === user.key && !a.queryLogId && a.sessionId && !sessionRows.has(a.sessionId)
    );
    const orphanTimes = spreadTimes(orphanSessions.length, user.activeDays, rand, now - 10 * 60_000);
    orphanSessions.forEach((a, i) => {
      sessionRows.set(a.sessionId!, { userId: a.userId, min: orphanTimes[i]!, max: orphanTimes[i]! });
    });
    const views = (state.views ?? []).filter((v) => v.user === user.key);
    const browseTimes = spreadTimes(views.length, user.activeDays, rand, now - 10 * 60_000);
    views.forEach((v, i) => {
      const cited = v.queryLogId ? askTime.get(v.queryLogId) : undefined;
      const t = cited !== undefined ? Math.min(cited + 30_000 + Math.floor(rand() * 210_000), now - 60_000) : browseTimes[i]!;
      viewRows.push([v.userId, v.documentId, t]);
    });
    const seeded = state.users?.[user.key];
    if (seeded?.created && user.email.endsWith("@larkspur.example")) {
      const earliest = Math.min(now - user.activeDays * DAY_MS, ...queryRows.filter((q) => q[1] === seeded.id).map((q) => q[2]), ...viewRows.filter((v) => v[0] === seeded.id).map((v) => v[2]));
      userRows.push([seeded.id, Math.floor(earliest / DAY_MS) * DAY_MS - DAY_MS + 14 * 3_600_000]);
    }
  }
  const iso = (t: number) => `'${new Date(t).toISOString()}'::timestamptz`;
  const uuidRe = /^[0-9a-f-]{36}$/i;
  for (const id of [...queryRows.flat(), ...viewRows.flat(), ...userRows.flat(), ...sessionRows.keys()]) {
    if (typeof id === "string" && !uuidRe.test(id)) throw new Error(`unexpected id ${id}`);
  }
  const values = (rows: string[]) => rows.join(",\n");
  const seedUserIds = users.map((u) => state.users?.[u.key]?.id).filter((v): v is string => Boolean(v));
  const expected = {
    query_log: queryRows.length,
    chat_sessions: sessionRows.size,
    kb_document_views: viewRows.length,
    users: userRows.length
  };
  // Window from the recorded view times, which come from the server, padded
  // for the gap between the open and the insert.
  const viewTimes = (state.views ?? []).map((v) => Date.parse(v.at));
  const step = {
    start: new Date(Math.min(...viewTimes, now) - 120_000).toISOString(),
    end: new Date(Math.max(...viewTimes, 0) + 120_000).toISOString()
  };
  const sql = `
CREATE TEMP TABLE bd_q (id uuid PRIMARY KEY, user_id text NOT NULL, ts timestamptz NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE bd_s (id uuid PRIMARY KEY, user_id text NOT NULL, created timestamptz NOT NULL, updated timestamptz NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE bd_v (user_id uuid NOT NULL, document_id uuid NOT NULL, ts timestamptz NOT NULL, PRIMARY KEY (user_id, document_id)) ON COMMIT DROP;
CREATE TEMP TABLE bd_u (id uuid PRIMARY KEY, ts timestamptz NOT NULL) ON COMMIT DROP;
${queryRows.length ? `INSERT INTO bd_q VALUES\n${values(queryRows.map(([id, u, t]) => `('${id}','${u}',${iso(t)})`))};` : ""}
${sessionRows.size ? `INSERT INTO bd_s VALUES\n${values([...sessionRows].map(([id, s]) => `('${id}','${s.userId}',${iso(s.min)},${iso(s.max)})`))};` : ""}
${viewRows.length ? `INSERT INTO bd_v VALUES\n${values(viewRows.map(([u, d, t]) => `('${u}','${d}',${iso(t)})`))};` : ""}
${userRows.length ? `INSERT INTO bd_u VALUES\n${values(userRows.map(([id, t]) => `('${id}',${iso(t)})`))};` : ""}
DO $$
DECLARE n integer;
BEGIN
  IF EXISTS (SELECT 1 FROM bd_q WHERE ts >= now()) OR EXISTS (SELECT 1 FROM bd_v WHERE ts >= now())
     OR EXISTS (SELECT 1 FROM bd_s WHERE updated >= now()) OR EXISTS (SELECT 1 FROM bd_u WHERE ts >= now()) THEN
    RAISE EXCEPTION 'a backdated time is in the future';
  END IF;
  UPDATE query_log AS q SET created_at = b.ts
    FROM bd_q AS b
   WHERE q.id = b.id AND q.user_id = b.user_id AND q.program_id = '${PROGRAM_ID}'::uuid
     AND q.user_id = ANY(ARRAY[${seedUserIds.map((id) => `'${id}'`).join(",")}]::text[]);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${expected.query_log} THEN RAISE EXCEPTION 'query_log: % rows matched, expected ${expected.query_log}', n; END IF;
  RAISE NOTICE 'query_log rows backdated: %', n;
  UPDATE chat_sessions AS s SET created_at = b.created, updated_at = b.updated
    FROM bd_s AS b
   WHERE s.id = b.id AND s.user_id = b.user_id AND s.program_id = '${PROGRAM_ID}'::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${expected.chat_sessions} THEN RAISE EXCEPTION 'chat_sessions: % rows matched, expected ${expected.chat_sessions}', n; END IF;
  RAISE NOTICE 'chat_sessions rows backdated: %', n;
  UPDATE kb_document_views AS v SET viewed_at = b.ts
    FROM bd_v AS b
   WHERE v.user_id = b.user_id AND v.document_id = b.document_id AND v.program_id = '${PROGRAM_ID}'::uuid
     AND v.viewed_at >= '${step.start}'::timestamptz AND v.viewed_at <= '${step.end}'::timestamptz;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${expected.kb_document_views} THEN RAISE EXCEPTION 'kb_document_views: % rows matched, expected ${expected.kb_document_views}', n; END IF;
  RAISE NOTICE 'kb_document_views rows backdated: %', n;
  UPDATE users AS u SET created_at = b.ts
    FROM bd_u AS b
   WHERE u.id = b.id AND u.email LIKE '%@larkspur.example' AND u.program_id = '${PROGRAM_ID}'::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> ${expected.users} THEN RAISE EXCEPTION 'users: % rows matched, expected ${expected.users}', n; END IF;
  RAISE NOTICE 'users rows backdated: %', n;
END
$$;
`;
  return { sql, expected };
}

const MAX_B64 = 6500; // Windows caps the command line near 8,000 characters.

function railwaySsh(script: string): number {
  const b64 = Buffer.from(script).toString("base64");
  if (b64.length > MAX_B64) throw new Error(`railway ssh payload too large (${b64.length})`);
  const result = spawnSync(
    "railway",
    ["ssh", "-p", RAILWAY_PROJECT, "-e", RAILWAY_ENVIRONMENT, "-s", "pgvector", "--", `"echo ${b64} | base64 -d | sh"`],
    { stdio: "inherit", shell: true }
  );
  return result.status ?? 1;
}

async function stepBackdate(state: SeedState): Promise<void> {
  if (state.backdatedAt) throw new Error(`already backdated at ${state.backdatedAt}; the view window guard would match nothing now`);
  if (!state.asks?.length || !state.viewStep?.end) throw new Error("run ask and views first");
  const { sql, expected } = buildBackdateSql(state, await serverNow());
  if (process.argv.includes("--dry-run")) {
    const out = path.join(path.dirname(STATE_PATH), "showcase-backdate.sql");
    writeFileSync(out, sql);
    console.log(`backdate: dry run, expecting ${JSON.stringify(expected)}; SQL written to ${out}`);
    return;
  }
  const sha = createHash("sha256").update(sql).digest("hex");
  const stage = `/tmp/truenote-showcase-${sha}.sql`;
  const sqlB64 = Buffer.from(sql).toString("base64");
  console.log(`backdate: expecting ${JSON.stringify(expected)}; ${sql.length} bytes of SQL`);
  const pieceLength = Math.floor(((MAX_B64 - 200) * 0.75) / 4) * 4;
  for (let i = 0, n = 0; i < sqlB64.length; i += pieceLength, n++) {
    const piece = sqlB64.slice(i, i + pieceLength);
    const status = railwaySsh(["set -eu", `echo ${piece} | base64 -d ${n === 0 ? ">" : ">>"} "${stage}"`].join("\n"));
    if (status !== 0) throw new Error(`uploading piece ${n + 1} failed`);
  }
  const psql = 'psql -h localhost -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -v ON_ERROR_STOP=1';
  const status = railwaySsh(
    [
      "set -eu",
      `tmp="${stage}"`,
      "trap 'rm -f \"$tmp\"' EXIT",
      `echo "${sha}  $tmp" | sha256sum -c --quiet -`,
      `${psql} --single-transaction -f "$tmp"`,
      'echo "backdate committed"'
    ].join("\n")
  );
  if (status !== 0) throw new Error(`backdate failed (exit ${status}); the transaction rolled back`);
  state.backdatedAt = new Date().toISOString();
  saveState(state);
}

async function stepVerify(state: SeedState): Promise<void> {
  const summary = (su: any) => ({
    windowDays: su.windowDays,
    totals: su.totals,
    people: su.people.map((p: any) => `${p.name}: ${p.questionCount}`),
    users: su.users.map((u: any) => `${u.name}: q ${u.questionCount}, answered ${u.answeredCount}, refused ${u.refusedCount}, thumbs down ${u.negativeCount}`),
    topSources: su.sources.slice(0, 5).map((s: any) => `${s.title ?? "(restricted)"}: ${s.citationCount} cites, ${s.viewCount} views`),
    restrictedSources: su.sources.filter((s: any) => s.title === null).length
  });
  await asAgent(async (api) => {
    const list = await kbList(api);
    const nested = list.categories.filter((c) => c.parentId).length;
    console.log(
      `verify: library ${list.items.length} sources, ${list.categories.length} folders (${nested} nested), ${list.tags.length} tags, ` +
        `team pins ${list.items.filter((i) => i.featuredPosition !== null).map((i) => i.title).join(", ")}, ` +
        `in no folder: ${list.items.filter((i) => i.categoryIds.length === 0).map((i) => i.title).join(", ")}, ` +
        `in two folders: ${list.items.filter((i) => i.categoryIds.length >= 2).length}`
    );
    for (const days of [30, 90]) {
      const su = (await api.call("GET", `/api/admin/insights/source-usage?days=${days}`)).json;
      console.log(`verify: source usage (agent, ${days} days)`, JSON.stringify(summary(su), null, 1));
    }
    const marcus = state.users?.marcus?.id;
    if (marcus) {
      const su = (await api.call("GET", `/api/admin/insights/source-usage?days=90&userId=${marcus}`)).json;
      console.log("verify: suggestions for Marcus Webb", JSON.stringify(su.suggestions));
    }
    const aisha = state.users?.aisha?.id;
    if (aisha) {
      const su = (await api.call("GET", `/api/admin/insights/source-usage?days=90&userId=${aisha}`)).json;
      console.log("verify: suggestions for Aisha Bello", JSON.stringify(su.suggestions));
    }
  });
  const manager = new Api("manager");
  const match = (await demoAccounts()).find((a) => a.email === "manager@demo.truenote");
  if (!match) throw new Error("manager demo account not published");
  await manager.login(match.email, match.password);
  try {
    const su = (await manager.call("GET", "/api/admin/insights/source-usage?days=90")).json;
    console.log("verify: source usage (manager@demo.truenote, 90 days)", JSON.stringify(summary(su), null, 1));
  } finally {
    await manager.logout();
  }
}

// ---------------------------------------------------------------------------

const STEPS: Record<string, (state: SeedState) => Promise<void>> = {
  upload: stepUpload,
  users: stepUsers,
  organize: stepOrganize,
  ask: stepAsk,
  views: stepViews,
  personal: () => stepPersonal(),
  backdate: stepBackdate,
  verify: stepVerify,
  plan: async () => {
    const plan = buildAskPlan();
    for (const p of plan) console.log(`${p.user.key}\t${p.kind}\t${p.question}`);
  }
};

async function main(): Promise<void> {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (requested.length === 0 || requested.some((s) => !STEPS[s])) {
    console.error(`usage: seed-showcase.ts <${Object.keys(STEPS).join("|")}> [...]`);
    process.exitCode = 2;
    return;
  }
  const state = loadState();
  for (const step of requested) {
    console.log(`== ${step}`);
    await STEPS[step]!(state);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
