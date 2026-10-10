// Seed data for the local fixture API. Deterministic: the same PRNG seed
// produces the same library, question log and views on every reset, with
// timestamps relative to the moment the seed runs.

const DAY = 24 * 60 * 60 * 1000;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let idCounter = 0;
/** UUID-shaped ids so anything that checks the format accepts them. */
export function nextId() {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}

export const CLEARANCE_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

// ---------------------------------------------------------------------------
// Documents. `created` / `updated` are days ago. `prev` adds an older
// version so citations from before the update open a historical version.

const DOCS = [
  {
    key: "cancel-fee",
    title: "Cancellation fee schedule",
    created: 210,
    updated: 40,
    tags: ["Policy", "Quick reference"],
    summary:
      "Early termination fees for every plan type, how proration works, and when a fee can be waived.",
    steps: [
      "Confirm the plan type and the contract start date in the billing profile.",
      "Look up the fee in the table below. Prorate monthly by the number of full months left.",
      "Read the fee to the caller before processing the cancellation.",
      "If the caller qualifies for a waiver, add the waiver code to the cancellation ticket."
    ],
    table: {
      head: ["Plan", "Fee in months 1 to 12", "Fee in months 13 to 24"],
      rows: [
        ["Essentials 24-month", "$200", "$100"],
        ["Unlimited Plus 24-month", "$325", "$150"],
        ["Business Pro 36-month", "$400", "$250"],
        ["Month-to-month", "$0", "$0"]
      ]
    },
    notes: [
      "Waivers apply for active-duty relocation (code MIL-REL) and documented service outages over 72 hours (code OUT-72).",
      "Never quote a fee for a plan that is not in this table. Escalate to billing instead."
    ],
    questions: [
      "What's the cancellation fee for Unlimited Plus in month 8?",
      "How much is the early termination fee on the Essentials plan?",
      "Can we waive the cancellation fee for a customer moving overseas?"
    ]
  },
  {
    key: "refund-annual",
    title: "Refund eligibility: annual plans",
    created: 180,
    updated: 6,
    prev: true,
    tags: ["Policy", "Updated"],
    summary:
      "Who can get a refund on a prepaid annual plan, how much, and which approvals are needed.",
    steps: [
      "Check the renewal date. Refunds are prorated from the renewal date, not the purchase date.",
      "Confirm there were no more than 2 plan changes in the current term.",
      "Calculate the unused months and multiply by the monthly equivalent rate.",
      "Refunds over $150 need a supervisor approval code before you submit."
    ],
    table: {
      head: ["Time since renewal", "Refund", "Approval"],
      rows: [
        ["0 to 30 days", "Full refund", "None"],
        ["31 to 180 days", "Prorated, minus $25 processing fee", "None under $150"],
        ["181 days or more", "Prorated, minus $50 processing fee", "Supervisor"],
        ["After a chargeback", "Not eligible", "Billing team only"]
      ]
    },
    notes: [
      "As of this update the processing fee for 31 to 180 days is $25 (was $35).",
      "Refunds go back to the original payment method within 7 to 10 business days."
    ],
    questions: [
      "Can a customer get a refund on an annual plan after 3 months?",
      "How do I calculate a prorated refund for an annual plan?",
      "Does an annual plan refund need supervisor approval?"
    ]
  },
  {
    key: "refund-monthly",
    title: "Refund eligibility: monthly plans",
    created: 180,
    updated: 60,
    tags: ["Policy"],
    summary: "Partial-month refunds and credits for monthly plans.",
    steps: [
      "Monthly plans do not get cash refunds for partial months.",
      "Offer a prorated account credit when the service was unusable for 3 or more days.",
      "Apply the credit with reason code CR-SVC and note the ticket number."
    ],
    table: {
      head: ["Situation", "What to offer", "Limit"],
      rows: [
        ["Billing error", "Full correction", "No limit"],
        ["Service down 3+ days", "Prorated credit", "1 month"],
        ["Customer changed their mind", "Nothing", "None"]
      ]
    },
    notes: ["Credits over one month of service go to the billing team."],
    questions: [
      "Can I refund half a month on a monthly plan?",
      "What credit do we give when service was down for 4 days?"
    ]
  },
  {
    key: "address-change",
    title: "Address change: identity verification",
    created: 300,
    updated: 25,
    tags: ["Compliance", "Script"],
    summary:
      "Verify the caller before changing a service or billing address. Address changes are a common fraud step.",
    steps: [
      "Complete the 3-point identity check first.",
      "Send a one-time code to the phone number on file. Do not send it to a number the caller gives you.",
      "Read back the new address and confirm the move date.",
      "If the caller fails any step, do not make the change and offer an in-store visit with photo ID."
    ],
    table: {
      head: ["Change", "Verification needed", "Cooling-off period"],
      rows: [
        ["Billing address", "3-point check + one-time code", "None"],
        ["Service address", "3-point check + one-time code", "None"],
        ["Shipping address for a new device", "3-point check + one-time code", "48 hours"]
      ]
    },
    notes: ["Never change an address and a phone number on the same call."],
    questions: [
      "What do I need to verify before changing a billing address?",
      "Can I update a shipping address and send a new phone on the same call?"
    ]
  },
  {
    key: "id-verify",
    title: "Caller identity verification (3-point check)",
    created: 320,
    updated: 90,
    tags: ["Compliance", "Script"],
    summary: "The standard identity check for every account-level request.",
    steps: [
      "Ask for the full name on the account.",
      "Ask for the account PIN or the last 4 digits of the payment card on file.",
      "Ask for the service address ZIP code.",
      "All 3 must match. Two attempts maximum, then end the account part of the call."
    ],
    table: {
      head: ["Item", "Accepted", "Not accepted"],
      rows: [
        ["Name", "Full legal name", "Nickname only"],
        ["Secret", "PIN or card last 4", "Date of birth"],
        ["Location", "Service ZIP", "Billing ZIP"]
      ]
    },
    notes: ["Authorized users pass the same check with their own PIN."],
    questions: [
      "What are the 3 points for identity verification?",
      "Can I accept date of birth instead of the PIN?",
      "How many verification attempts does a caller get?"
    ]
  },
  {
    key: "pw-reset",
    title: "Password reset and account unlock",
    created: 150,
    updated: 12,
    prev: true,
    tags: ["Script"],
    summary: "Reset the online account password or unlock an account after failed logins.",
    steps: [
      "Complete the 3-point identity check.",
      "Trigger the reset link from the account tools page. The link expires in 30 minutes.",
      "If the account is locked, unlock it first, then send the reset link.",
      "Remind the caller that agents never ask for the new password."
    ],
    table: {
      head: ["State", "Action", "Wait time"],
      rows: [
        ["Locked after 5 failed logins", "Unlock, then reset", "None"],
        ["Locked by fraud team", "Do not unlock; transfer to fraud", "N/A"],
        ["Reset link expired", "Send a new link", "None"]
      ]
    },
    notes: ["Updated: links now expire in 30 minutes instead of 24 hours."],
    questions: [
      "How long does a password reset link last?",
      "Customer is locked out after too many logins, what do I do?"
    ]
  },
  {
    key: "retention-offers",
    title: "Retention offers by tenure",
    created: 120,
    updated: 30,
    tags: ["Script", "Policy"],
    summary: "Which save offers you can make, based on how long the customer has been with us.",
    steps: [
      "Ask why the customer wants to leave before offering anything.",
      "Find the tenure band in the table and offer the first option only.",
      "Offer the second option only if the first is declined.",
      "Log the offer and the outcome in the retention notes field."
    ],
    table: {
      head: ["Tenure", "First offer", "Second offer"],
      rows: [
        ["Under 1 year", "$10 off for 3 months", "Free plan change"],
        ["1 to 3 years", "$15 off for 6 months", "Free device protection for 6 months"],
        ["Over 3 years", "$20 off for 12 months", "Loyalty upgrade"]
      ]
    },
    notes: ["Offers do not stack with promotional pricing that is still active."],
    questions: [
      "What retention offer can I give someone with 2 years of tenure?",
      "Can I stack a retention discount with a promo?"
    ]
  },
  {
    key: "save-script",
    title: "Save-the-sale call script",
    created: 100,
    updated: 45,
    tags: ["Script"],
    summary: "Talk track for cancellation calls.",
    steps: [
      "Acknowledge: \"I understand, and I want to make sure we get this right for you.\"",
      "Ask: \"What is the main reason you are thinking of leaving?\"",
      "Match the reason to an offer in Retention offers by tenure.",
      "If the customer still wants to cancel, process it without further pushback."
    ],
    table: {
      head: ["Reason", "Lead with", "Avoid"],
      rows: [
        ["Price", "Tenure offer", "Arguing about competitor prices"],
        ["Coverage", "Coverage map check", "Promising future towers"],
        ["Moving", "Address transfer", "Cancellation fee talk first"]
      ]
    },
    notes: ["Two save attempts maximum per call."],
    questions: ["What should I say when a customer wants to cancel over price?"]
  },
  {
    key: "late-fee",
    title: "Late payment fee waivers",
    created: 200,
    updated: 70,
    tags: ["Policy"],
    summary: "When agents can waive a late fee without approval.",
    steps: [
      "Check the last 12 months for prior waivers.",
      "First waiver in 12 months: waive it, no approval needed.",
      "Second waiver: supervisor approval code required.",
      "Third or more: decline and offer a payment extension."
    ],
    table: {
      head: ["Waivers in last 12 months", "Agent can waive", "Approval"],
      rows: [
        ["0", "Yes", "None"],
        ["1", "Yes", "Supervisor code"],
        ["2 or more", "No", "Billing team"]
      ]
    },
    notes: ["The late fee is $10 or 5% of the past-due balance, whichever is greater."],
    questions: [
      "Can I waive a late fee?",
      "How much is the late fee?",
      "Customer already had a late fee waived this year, can I do it again?"
    ]
  },
  {
    key: "billing-dispute",
    title: "Billing dispute intake",
    created: 140,
    updated: 50,
    tags: ["Escalation"],
    summary: "How to open a billing dispute ticket and what to tell the customer.",
    steps: [
      "Identify the charge, the amount and the statement date.",
      "Open a dispute ticket with category BILL-DSP.",
      "Place the disputed amount on hold so it does not trigger late fees.",
      "Tell the customer the billing team responds within 5 business days."
    ],
    table: {
      head: ["Disputed amount", "Hold placed", "Team"],
      rows: [
        ["Under $50", "Automatic", "Billing tier 1"],
        ["$50 to $500", "Agent places hold", "Billing tier 2"],
        ["Over $500", "Agent places hold", "Billing supervisor"]
      ]
    },
    notes: ["Disputes older than 90 days from the statement date are not accepted."],
    questions: ["How do I open a billing dispute?", "How long does a billing dispute take?"]
  },
  {
    key: "autopay",
    title: "Autopay enrollment and changes",
    created: 90,
    updated: 90,
    tags: [],
    summary: "Enroll, change or remove autopay and explain the autopay discount.",
    steps: [
      "Autopay gives a $5 monthly discount per line, up to 5 lines.",
      "Changes made after the 20th apply to the next billing cycle.",
      "Removing autopay removes the discount from the next bill."
    ],
    table: {
      head: ["Payment method", "Autopay allowed", "Discount"],
      rows: [
        ["Bank account", "Yes", "$5 per line"],
        ["Debit card", "Yes", "$5 per line"],
        ["Credit card", "Yes", "$0"]
      ]
    },
    notes: [],
    questions: ["Does autopay with a credit card get the discount?"]
  },
  {
    key: "payment-ext",
    title: "Payment extension requests",
    created: 3,
    updated: 3,
    tags: ["Policy"],
    summary: "New policy: agents can grant a payment extension of up to 14 days.",
    steps: [
      "The account must be current or no more than 30 days past due.",
      "Grant up to 14 days. One extension per 6 months.",
      "Service stays on during the extension.",
      "Set the reminder text to go out 2 days before the new due date."
    ],
    table: {
      head: ["Days past due", "Extension", "Approval"],
      rows: [
        ["0", "Up to 14 days", "None"],
        ["1 to 30", "Up to 7 days", "None"],
        ["Over 30", "Not available", "Collections"]
      ]
    },
    notes: ["This replaces the old 7-day courtesy extension."],
    questions: [
      "How many days can I extend a payment due date?",
      "Can a customer 20 days past due get an extension?"
    ]
  },
  {
    key: "device-return",
    title: "Device return and restocking fee",
    created: 160,
    updated: 80,
    tags: ["Policy", "Quick reference"],
    summary: "Return windows and restocking fees for devices.",
    steps: [
      "Returns are accepted within 14 days of delivery.",
      "The device must be in like-new condition with all accessories.",
      "Generate a prepaid return label from the order page."
    ],
    table: {
      head: ["Device", "Restocking fee", "Window"],
      rows: [
        ["Phone", "$50", "14 days"],
        ["Tablet", "$35", "14 days"],
        ["Accessory", "$0", "30 days"]
      ]
    },
    notes: ["Restocking fees are waived when the device arrived damaged."],
    questions: ["What's the restocking fee on a returned phone?", "How long do customers have to return a device?"]
  },
  {
    key: "warranty",
    title: "Device warranty claims",
    created: 130,
    updated: 130,
    tags: [],
    summary: "Manufacturer warranty coverage and how to file a claim.",
    steps: [
      "Warranty covers defects for 12 months from purchase.",
      "Physical and liquid damage are not covered.",
      "File the claim in the device portal and ship with the prepaid box."
    ],
    table: {
      head: ["Issue", "Covered", "Next step"],
      rows: [
        ["Battery will not charge", "Yes", "Warranty claim"],
        ["Cracked screen", "No", "Device protection claim"],
        ["Water damage", "No", "Device protection claim"]
      ]
    },
    notes: [],
    questions: ["Is a battery that won't charge covered under warranty?"]
  },
  {
    key: "roaming",
    title: "International roaming add-ons",
    created: 75,
    updated: 75,
    tags: ["Quick reference"],
    summary: "Day passes and monthly roaming packs.",
    steps: [
      "Add the pass before the customer travels. It cannot be backdated.",
      "Day passes charge only on days the phone is used abroad."
    ],
    table: {
      head: ["Add-on", "Price", "Includes"],
      rows: [
        ["Travel day pass", "$10 per day", "Your plan's data, talk and text"],
        ["Monthly pack", "$60", "5 GB, 300 minutes"],
        ["Cruise pack", "$25 per day", "Talk and text only"]
      ]
    },
    notes: [],
    questions: ["How much is the international day pass?", "Can I backdate a roaming pass?"]
  },
  {
    key: "plan-change",
    title: "Plan change: proration rules",
    created: 60,
    updated: 20,
    tags: ["Policy"],
    summary: "How mid-cycle plan changes are billed.",
    steps: [
      "Upgrades apply immediately and are prorated for the rest of the cycle.",
      "Downgrades apply at the start of the next cycle.",
      "Explain that the next bill can show two partial charges."
    ],
    table: {
      head: ["Change", "Takes effect", "Billing"],
      rows: [
        ["Upgrade", "Immediately", "Prorated"],
        ["Downgrade", "Next cycle", "No proration"],
        ["Add a line", "Immediately", "Prorated"]
      ]
    },
    notes: [],
    questions: ["Does a downgrade take effect right away?", "Why does the bill show two charges after an upgrade?"]
  },
  {
    key: "outage-credit",
    title: "Service outage credits",
    created: 9,
    updated: 9,
    tags: ["Policy"],
    summary: "Credits for confirmed network outages in the customer's area.",
    steps: [
      "Confirm the outage on the network status page using the service ZIP.",
      "Outages over 24 hours: one day of service credit per day affected.",
      "Outages over 72 hours also qualify for a cancellation fee waiver (code OUT-72)."
    ],
    table: {
      head: ["Outage length", "Credit", "Fee waiver"],
      rows: [
        ["Under 24 hours", "None", "No"],
        ["24 to 72 hours", "1 day per day", "No"],
        ["Over 72 hours", "1 day per day", "Yes"]
      ]
    },
    notes: [],
    questions: ["What credit do we give for a 2 day outage?", "Does a long outage waive the cancellation fee?"]
  },
  {
    key: "port-out",
    title: "Number port-out PIN requests",
    created: 110,
    updated: 110,
    tags: ["Compliance"],
    summary: "Generate a port-out PIN when a customer moves their number to another carrier.",
    steps: [
      "Complete the 3-point identity check.",
      "Generate the PIN from account tools. It is valid for 7 days.",
      "Read the account number and PIN to the account owner only."
    ],
    table: {
      head: ["Caller", "Can get PIN", "Note"],
      rows: [
        ["Account owner", "Yes", "After 3-point check"],
        ["Authorized user", "No", "Owner must call"],
        ["Business admin", "Yes", "With business PIN"]
      ]
    },
    notes: [],
    questions: ["Can an authorized user get a port-out PIN?"]
  },
  {
    key: "hold-time",
    title: "Hold and transfer etiquette",
    created: 400,
    updated: 400,
    tags: ["Script"],
    summary: "Hold limits and warm transfer steps.",
    steps: [
      "Ask permission before placing a caller on hold.",
      "Check back every 2 minutes.",
      "Use warm transfers: introduce the caller and the reason before you drop off."
    ],
    table: {
      head: ["Hold length", "Action"],
      rows: [
        ["Up to 2 minutes", "Check back"],
        ["Over 5 minutes", "Offer a callback"]
      ]
    },
    notes: [],
    questions: []
  },
  {
    key: "tax-fee",
    title: "Taxes and regulatory fees explained",
    created: 190,
    updated: 190,
    tags: ["Quick reference"],
    summary: "Plain explanations for each tax and fee line on the bill.",
    steps: [
      "Taxes vary by service address, not billing address.",
      "Regulatory fees are set by us and listed in the fee table."
    ],
    table: {
      head: ["Line item", "What it is", "Typical amount"],
      rows: [
        ["Federal USF", "Federal universal service fund", "About 3% of service"],
        ["911 fee", "Local emergency services", "$0.50 to $2 per line"],
        ["Regulatory cost recovery", "Company fee", "$3.49 per line"]
      ]
    },
    notes: [],
    questions: ["What is the regulatory cost recovery fee?"]
  },
  {
    key: "student",
    title: "Student discount verification",
    created: 85,
    updated: 85,
    tags: [],
    summary: "Eligibility and verification for the student discount.",
    steps: [
      "Customer verifies through the student portal with a school email.",
      "Agents cannot apply the discount manually."
    ],
    table: {
      head: ["Plan", "Discount"],
      rows: [
        ["Essentials", "$5 per month"],
        ["Unlimited Plus", "$10 per month"]
      ]
    },
    notes: [],
    questions: []
  },
  {
    key: "military",
    title: "Military and veteran discount",
    created: 85,
    updated: 85,
    tags: [],
    summary: "Discount amounts and accepted proof of service.",
    steps: [
      "Verification is done through the military portal.",
      "The discount applies to up to 6 lines."
    ],
    table: {
      head: ["Status", "Discount"],
      rows: [
        ["Active duty", "25% off service"],
        ["Veteran", "15% off service"]
      ]
    },
    notes: [],
    questions: ["How much is the veteran discount?"]
  },
  {
    key: "suspension",
    title:
      "Temporary service suspension for military deployment, extended medical leave, or natural disaster relief (all regions)",
    created: 45,
    updated: 45,
    tags: ["Policy"],
    summary: "Pause service and billing for qualifying situations.",
    steps: [
      "Suspensions last up to 6 months and can be renewed once.",
      "Deployment needs orders; medical leave needs a provider letter; disaster relief needs only the service ZIP.",
      "The number is kept during the suspension."
    ],
    table: {
      head: ["Reason", "Documentation", "Monthly charge"],
      rows: [
        ["Military deployment", "Deployment orders", "$0"],
        ["Medical leave", "Provider letter", "$5 per line"],
        ["Natural disaster", "None (ZIP in declared area)", "$0"]
      ]
    },
    notes: [],
    questions: ["Can a customer pause service while deployed?"]
  },
  {
    key: "accessibility",
    title: "Accessibility services: TTY and relay calls",
    created: 260,
    updated: 260,
    tags: [],
    summary: "Handling relay calls and accessibility plan options.",
    steps: [
      "Relay calls follow the same verification as any other call.",
      "Speak to the customer, not the relay operator."
    ],
    table: {
      head: ["Service", "How to reach"],
      rows: [["TTY", "711"], ["Video relay", "Customer's VRS provider"]]
    },
    notes: [],
    questions: []
  },
  {
    key: "paperless",
    title: "Paperless billing opt-out",
    created: 1,
    updated: 1,
    tags: [],
    summary: "New: customers can switch back to paper statements.",
    steps: [
      "Paper statements cost $2 per month.",
      "The change applies to the next statement."
    ],
    table: {
      head: ["Statement", "Cost"],
      rows: [["Paperless", "$0"], ["Paper", "$2 per month"]]
    },
    notes: [],
    questions: []
  },
  {
    key: "escalation",
    title: "Supervisor escalation criteria",
    created: 220,
    updated: 35,
    tags: ["Escalation"],
    summary: "When to escalate to a supervisor and how to hand off.",
    steps: [
      "Escalate on a third request from the caller, any legal threat, or any credit over $150.",
      "Summarize the issue in the escalation note before the transfer.",
      "Stay on the line until the supervisor joins."
    ],
    table: {
      head: ["Trigger", "Escalate to", "Response time"],
      rows: [
        ["Caller asks a third time", "Floor supervisor", "Immediate"],
        ["Legal threat", "Floor supervisor", "Immediate"],
        ["Credit over $150", "Floor supervisor", "Same call"]
      ]
    },
    notes: [],
    questions: ["When should I escalate a call to a supervisor?", "Do I need a supervisor for a $200 credit?"]
  },
  {
    key: "deceased",
    title: "Deceased account holder: account closure",
    created: 250,
    updated: 100,
    tags: ["Compliance", "Escalation"],
    summary: "Close or transfer an account after the account holder has died.",
    steps: [
      "Offer condolences and move the call to the bereavement queue.",
      "A death certificate or obituary is required.",
      "Cancellation fees are waived."
    ],
    table: {
      head: ["Request", "Documentation"],
      rows: [
        ["Close account", "Death certificate or obituary"],
        ["Transfer to a family member", "Death certificate + new owner credit check"]
      ]
    },
    notes: [],
    questions: ["How do I close an account for a customer who passed away?"]
  },
  {
    key: "fraud",
    title: "Fraud team handoff: account takeover",
    created: 70,
    updated: 70,
    classification: "confidential",
    tags: ["Escalation"],
    summary: "Signals of account takeover and the warm handoff to the fraud team.",
    steps: [
      "Signals: recent SIM swap, new device shipped to a new address, PIN changed in the last 48 hours.",
      "Do not tell the caller which signal triggered the handoff.",
      "Transfer to fraud on queue 4410."
    ],
    table: {
      head: ["Signal", "Action"],
      rows: [
        ["SIM swap in last 24 hours", "Lock account, transfer"],
        ["Two failed 3-point checks", "End account discussion, flag"]
      ]
    },
    notes: [],
    questions: ["What are the account takeover signals?"]
  },
  {
    key: "exec-contacts",
    title: "Executive escalations contact list",
    created: 300,
    updated: 300,
    classification: "restricted",
    tags: [],
    summary: "Direct contacts for executive complaints.",
    steps: ["Only managers on the executive response team use this list."],
    table: {
      head: ["Team", "Contact"],
      rows: [["Executive response", "Restricted"]]
    },
    notes: [],
    questions: ["Who handles executive complaints?"]
  },
  {
    key: "legacy-unlimited",
    title: "Legacy unlimited plan grandfathering",
    created: 400,
    updated: 400,
    retired: true,
    tags: [],
    summary: "Retired: rules for keeping the 2019 unlimited plan.",
    steps: ["This plan was retired. Customers were migrated to Unlimited Plus."],
    table: {
      head: ["Plan", "Status"],
      rows: [["Unlimited 2019", "Retired"]]
    },
    notes: [],
    questions: ["Can a customer keep the old unlimited plan if they add a line?"]
  }
];

function renderMarkdown(doc, older) {
  const lines = [];
  lines.push(`# ${doc.title}`);
  lines.push("");
  lines.push(doc.summary);
  lines.push("");
  lines.push("## When to use this");
  lines.push("");
  lines.push(`- The caller asks about ${doc.title.toLowerCase()}.`);
  lines.push("- You need the exact amount, limit or approval rule before you answer.");
  lines.push("- A supervisor asks you to confirm the current policy.");
  lines.push("");
  lines.push("## Steps");
  lines.push("");
  doc.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("");
  lines.push("## Reference");
  lines.push("");
  lines.push(`| ${doc.table.head.join(" | ")} |`);
  lines.push(`| ${doc.table.head.map(() => "---").join(" | ")} |`);
  for (const row of doc.table.rows) lines.push(`| ${row.join(" | ")} |`);
  lines.push("");
  const notes = older
    ? doc.notes.filter((note) => !/^(As of this update|Updated:)/.test(note))
    : doc.notes;
  if (older) notes.push("This version is superseded. Check the current version before quoting amounts.");
  if (notes.length > 0) {
    lines.push("## Notes");
    lines.push("");
    for (const note of notes) lines.push(`> ${note}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Citable passages: summary, steps, and table rows, with offsets into the markdown. */
function passagesOf(markdown) {
  const out = [];
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const trimmed = line.replace(/^(\d+\. |> |- )/, "");
    const leading = line.length - trimmed.length;
    if (!line.startsWith("#") && !line.startsWith("|") && trimmed.length >= 30) {
      out.push({ text: trimmed, start: offset + leading, end: offset + line.length });
    }
    offset += line.length + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------

const REFUSED_QUESTIONS = [
  "Can we waive the activation fee for a business line?",
  "What is the trade-in value for a phone with a cracked screen?",
  "Do we price-match competitor promotions?",
  "How do I add a line for a minor without an ID?",
  "Is there a fee for paper statements in Quebec?",
  "Can a customer split one bill across two credit cards?"
];

const COLORS = ["slate", "blue", "green", "amber", "red", "violet", "teal", "pink"];

export function buildSeed() {
  idCounter = 0;
  const rand = mulberry32(20261007);
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const daysAgo = (days) => now - days * DAY;
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const programs = [
    { id: nextId(), name: "Acme Wireless Care", createdAt: iso(daysAgo(420)) },
    { id: nextId(), name: "Northwind Insurance", createdAt: iso(daysAgo(30)) }
  ];
  const programId = programs[0].id;

  const mkUser = (name, email, role, clearance, extra = {}) => ({
    id: nextId(),
    name,
    email,
    role,
    programId: role === "super_user" ? null : extra.programId ?? programId,
    clearance,
    isActive: true,
    mustResetPassword: false,
    isDemo: extra.isDemo === true,
    createdAt: iso(daysAgo(extra.createdDays ?? 200)),
    lastLoginAt: iso(now - Math.floor(rand() * 3 * DAY))
  });

  const users = [
    mkUser("Maria Chen", "maria.chen@acme-wireless.example", "manager", "confidential"),
    mkUser("Demo Manager", "demo.manager@truenote.example", "manager", "confidential", { isDemo: true }),
    mkUser("Sam Okafor", "sam.okafor@truenote.example", "super_user", "restricted"),
    mkUser("Jordan Reyes", "jordan.reyes@acme-wireless.example", "csr", "internal"),
    mkUser("Aisha Bello", "aisha.bello@acme-wireless.example", "csr", "internal"),
    mkUser("Marcus Webb", "marcus.webb@acme-wireless.example", "csr", "internal"),
    mkUser("Tomas Rivera", "tomas.rivera@acme-wireless.example", "csr", "internal"),
    mkUser("Kim Nguyen", "kim.nguyen@acme-wireless.example", "csr", "internal"),
    mkUser("Priya Shah", "priya.shah@acme-wireless.example", "csr", "internal"),
    mkUser("Devon Clarke", "devon.clarke@acme-wireless.example", "csr", "internal", { createdDays: 2 }),
    mkUser("Lena Park", "lena.park@northwind.example", "csr", "internal", { programId: programs[1].id })
  ];
  const byName = Object.fromEntries(users.map((u) => [u.name.split(" ")[0].toLowerCase(), u]));

  // Documents and versions.
  const documents = DOCS.map((spec) => {
    const id = nextId();
    const versions = [];
    if (spec.prev) {
      const markdown = renderMarkdown(spec, true);
      versions.push({
        id: nextId(),
        versionNumber: 1,
        uploadedAt: iso(daysAgo(spec.created) + 3600 * 1000),
        markdown,
        passages: passagesOf(markdown)
      });
    }
    const markdown = renderMarkdown(spec, false);
    versions.push({
      id: nextId(),
      versionNumber: versions.length + 1,
      uploadedAt: iso(daysAgo(spec.updated) + 2 * 3600 * 1000),
      markdown,
      passages: passagesOf(markdown)
    });
    return {
      id,
      key: spec.key,
      programId,
      title: spec.title,
      createdAt: iso(daysAgo(spec.created)),
      classification: spec.classification ?? "internal",
      retired: spec.retired === true,
      versions,
      activeVersionId: versions[versions.length - 1].id,
      questions: spec.questions,
      tagNames: spec.tags
    };
  });
  const doc = Object.fromEntries(documents.map((d) => [d.key, d]));

  // Tags.
  const tagSpecs = [
    ["Policy", "blue"],
    ["Script", "green"],
    ["Compliance", "red"],
    ["Updated", "amber"],
    ["Quick reference", "teal"],
    ["Escalation", "violet"]
  ];
  const tags = tagSpecs.map(([name, color]) => ({ id: nextId(), programId, name, color }));
  const tagByName = Object.fromEntries(tags.map((t) => [t.name, t]));
  const docTags = [];
  for (const d of documents) {
    for (const name of d.tagNames) docTags.push({ documentId: d.id, tagId: tagByName[name].id });
  }

  // Categories: Billing / Refunds / Annual plans is the 3-level path,
  // Escalations stays empty, refund-annual sits in two categories.
  const categories = [];
  const categoryDocs = [];
  const mkCat = (name, color, parent, position, docKeys) => {
    const cat = { id: nextId(), programId, parentId: parent?.id ?? null, name, color, position };
    categories.push(cat);
    docKeys.forEach((key, index) =>
      categoryDocs.push({ categoryId: cat.id, documentId: doc[key].id, position: index })
    );
    return cat;
  };
  const billing = mkCat("Billing", "blue", null, 0, ["tax-fee", "autopay", "paperless"]);
  const refunds = mkCat("Refunds", "green", billing, 0, ["refund-monthly"]);
  mkCat("Annual plans", "green", refunds, 0, ["refund-annual"]);
  mkCat("Fees", "amber", billing, 1, ["cancel-fee", "late-fee", "device-return"]);
  mkCat("Payments", "teal", billing, 2, ["payment-ext", "billing-dispute"]);
  const security = mkCat("Account security", "red", null, 1, ["port-out"]);
  mkCat("Identity verification", "red", security, 0, ["id-verify", "address-change", "pw-reset", "fraud"]);
  mkCat("Retention", "violet", null, 2, ["retention-offers", "save-script", "refund-annual", "student", "military"]);
  mkCat("Plans and service", "slate", null, 3, ["plan-change", "roaming", "outage-credit", "suspension"]);
  mkCat("Escalations", "pink", null, 4, []);

  const featured = ["cancel-fee", "id-verify", "outage-credit"].map((key, position) => ({
    programId,
    documentId: doc[key].id,
    position
  }));

  // Personal pins, notes and colors (kb_source_user_state).
  const userState = new Map();
  const setState = (user, key, value) => {
    userState.set(`${user.id}:${doc[key].id}`, {
      pinnedAt: value.pinnedDays === undefined ? null : iso(daysAgo(value.pinnedDays)),
      note: value.note ?? null,
      noteUpdatedAt: value.note ? iso(daysAgo(value.noteDays ?? 1)) : null,
      color: value.color ?? null
    });
  };
  const jordan = byName.jordan;
  setState(jordan, "refund-annual", {
    pinnedDays: 3,
    color: "green",
    note: "Prorate from the renewal date, not the purchase date. Ask for the order number first, then check for a chargeback before quoting anything.",
    noteDays: 2
  });
  setState(jordan, "pw-reset", { pinnedDays: 10 });
  setState(jordan, "late-fee", {
    pinnedDays: 20,
    note: "Check the waiver history tab first. Second waiver needs Maria's code.",
    noteDays: 15
  });
  setState(jordan, "warranty", {
    note: "Customers often call this a 'repair'. If the screen is cracked it is a device protection claim, not warranty.",
    noteDays: 30
  });
  // Color only, no pin or note: the row exists because of the color.
  setState(jordan, "cancel-fee", { color: "red" });
  // Six pins in total so numbered pins 1 to 6 show; four notes, one over 300 characters.
  setState(jordan, "id-verify", { pinnedDays: 1, color: "blue" });
  setState(jordan, "address-change", { pinnedDays: 6 });
  setState(jordan, "outage-credit", {
    pinnedDays: 8,
    note:
      "Confirm the outage ticket in the network status tool before promising anything. Credits are prorated by the hour, " +
      "rounded up to the next full day, and only for outages longer than 4 hours. If the caller had two outages in the same " +
      "cycle, add them together. Business accounts get the credit on the next bill; prepaid lines get it as account balance.",
    noteDays: 4
  });
  // More color-only marks so each of Jordan's named colors filters to something:
  // 4 red, 2 green, 2 amber (plus the blue on id-verify).
  const paint = (user, key, color) => {
    const k = `${user.id}:${doc[key].id}`;
    const existing = userState.get(k) ?? { pinnedAt: null, note: null, noteUpdatedAt: null, color: null };
    userState.set(k, { ...existing, color });
  };
  for (const key of ["late-fee", "device-return", "billing-dispute"]) paint(jordan, key, "red");
  paint(jordan, "pw-reset", "green");
  for (const key of ["roaming", "plan-change"]) paint(jordan, key, "amber");
  setState(byName.maria, "escalation", { pinnedDays: 5 });
  setState(byName.maria, "refund-annual", { note: "Coach the team on the new $25 fee.", noteDays: 5 });

  // Personal names for colors (kb_user_color_labels), per user across programs.
  const colorLabels = new Map();
  for (const [color, name, days] of [
    ["red", "Read before quoting fees", 12],
    ["green", "Easy wins", 9],
    ["amber", "Changes often", 3]
  ]) {
    colorLabels.set(`${jordan.id}:${color}`, { name, updatedAt: iso(daysAgo(days)) });
  }

  // Personal category colors (kb_category_user_prefs): Jordan sees Retention
  // in pink instead of the team's violet.
  const categoryPrefs = new Map();
  const retention = categories.find((c) => c.name === "Retention");
  categoryPrefs.set(`${jordan.id}:${retention.id}`, { color: "pink", updatedAt: iso(daysAgo(4)) });

  // Question log. Popularity follows a power law over the docs that have
  // questions; a handful of live documents are never cited.
  const askers = [
    [byName.jordan, 25],
    [byName.aisha, 20],
    [byName.marcus, 18],
    [byName.tomas, 15],
    [byName.kim, 12],
    [byName.priya, 6],
    [byName.maria, 5]
  ];
  const askerTotal = askers.reduce((sum, [, w]) => sum + w, 0);
  const pickAsker = () => {
    let r = rand() * askerTotal;
    for (const [user, weight] of askers) {
      r -= weight;
      if (r <= 0) return user;
    }
    return askers[0][0];
  };
  const citable = documents.filter((d) => d.questions.length > 0);
  const weights = citable.map((_, rank) => 1 / Math.pow(rank + 1, 0.95));
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const pickDoc = () => {
    let r = rand() * weightTotal;
    for (let i = 0; i < citable.length; i += 1) {
      r -= weights[i];
      if (r <= 0) return citable[i];
    }
    return citable[0];
  };
  const canSee = (user, d) => CLEARANCE_RANK[user.clearance] >= CLEARANCE_RANK[d.classification];
  const versionAt = (d, atMs) => {
    let chosen = d.versions[0];
    for (const v of d.versions) if (Date.parse(v.uploadedAt) <= atMs) chosen = v;
    return chosen;
  };

  const queryLog = [];
  const makeRow = (user, ageDays, primary, opts = {}) => {
    const createdMs = now - ageDays * DAY;
    const row = {
      id: nextId(),
      programId,
      userId: user.id,
      sessionId: null,
      question: "",
      answer: "",
      createdAt: iso(createdMs),
      refused: primary === null,
      feedback: null,
      flaggedMissing: false,
      latencyMs: 900 + Math.floor(rand() * 2600),
      citations: []
    };
    if (primary === null) {
      row.question = opts.question ?? pick(REFUSED_QUESTIONS);
      row.answer = "I couldn't find this in the knowledge base.";
      row.flaggedMissing = rand() < 0.4;
      row.feedback = rand() < 0.2 ? -1 : null;
      if (opts.feedback !== undefined) row.feedback = opts.feedback;
      queryLog.push(row);
      return;
    }
    row.question = opts.question ?? pick(primary.questions);
    const cited = [primary];
    if (rand() < 0.45) {
      const second = pickDoc();
      if (second !== primary && canSee(user, second) && !second.retired) cited.push(second);
    }
    // Two chunks from the same document in one answer (dedupe case).
    if (rand() < 0.15) cited.push(primary);
    const sentences = [];
    cited.forEach((d, index) => {
      const version = versionAt(d, createdMs);
      const passage = version.passages[Math.floor(rand() * version.passages.length)];
      const chunkId = nextId();
      row.citations.push({
        chunk_id: chunkId,
        doc_title: d.title,
        excerpt: passage.text,
        doc_id: d.id,
        document_version_id: version.id,
        version_number: version.versionNumber,
        citation_index: index,
        source_start: passage.start,
        source_end: passage.end
      });
      sentences.push(`${passage.text} [${chunkId}]`);
    });
    row.answer = sentences.join("\n\n");
    const fb = rand();
    const negativeBias = primary.key === "late-fee" || primary.key === "plan-change" ? 0.25 : 0.07;
    row.feedback = fb < negativeBias ? -1 : fb < negativeBias + 0.22 ? 1 : null;
    if (opts.feedback !== undefined) row.feedback = opts.feedback;
    queryLog.push(row);
  };

  const ROWS = 300;
  for (let i = 0; i < ROWS; i += 1) {
    const user = pickAsker();
    // Priya has not asked anything in the last 20 days (empty 7-day window).
    const minDays = user === byName.priya ? 20 : 0;
    const ageDays = minDays + rand() * (90 - minDays);
    if (rand() < 0.12) {
      makeRow(user, ageDays, null);
      continue;
    }
    // CSRs only get answers from documents they can see; new documents only
    // get questions after they were added; the retired plan is handled below.
    let primary = pickDoc();
    let guard = 0;
    while (
      guard < 50 &&
      (!canSee(user, primary) ||
        primary.retired ||
        (now - Date.parse(primary.createdAt)) / DAY < ageDays)
    ) {
      primary = pickDoc();
      guard += 1;
    }
    makeRow(user, ageDays, primary);
  }
  // Fixed rows: the retired plan (cited only 60+ days ago, so isLive false in
  // the 90-day window), plus the confidential and restricted documents that
  // only Maria's rows cite (restricted shows as "Restricted source").
  for (const [name, age] of [["jordan", 64], ["aisha", 71], ["marcus", 78], ["kim", 85]]) {
    makeRow(byName[name], age, doc["legacy-unlimited"]);
  }
  for (const age of [4, 12, 26, 40]) makeRow(byName.maria, age, doc["fraud"]);
  for (const age of [8, 33]) makeRow(byName.maria, age, doc["exec-contacts"]);
  for (const age of [2, 5, 11, 19, 27]) makeRow(byName.tomas, age, doc["escalation"]);
  // Recently added documents pick up questions right away.
  for (const [name, age] of [["jordan", 1], ["aisha", 2.5], ["kim", 4], ["marcus", 6], ["jordan", 8]]) {
    makeRow(byName[name], age, doc["outage-credit"]);
  }
  for (const [name, age] of [["aisha", 0.4], ["tomas", 1.2], ["jordan", 2.1]]) {
    makeRow(byName[name], age, doc["payment-ext"]);
  }
  // The same question from four people, written differently, all citing the
  // cancellation fee schedule: groups into one question on Source usage.
  for (const [name, age, question] of [
    ["aisha", 1.5, "What is the cancellation fee for Unlimited Plus?"],
    ["marcus", 3.2, "what is the cancellation fee for unlimited plus"],
    ["kim", 6.4, "What is the cancellation fee for Unlimited Plus ?"],
    ["tomas", 9.1, "WHAT IS THE CANCELLATION FEE FOR UNLIMITED PLUS?!"]
  ]) {
    makeRow(byName[name], age, doc["cancel-fee"], { question });
  }
  // Coaching suggestions for Jordan: a refused question a teammate got answered
  // from Retention, and a thumbs-down answer from the late payment fee source.
  makeRow(jordan, 2.6, null, { question: "Do we price-match competitor promotions?", feedback: null });
  makeRow(byName.tomas, 5.3, doc["retention-offers"], { question: "do we price-match competitor promotions" });
  makeRow(byName.aisha, 7.7, doc["save-script"], { question: "Do we price-match competitor promotions." });
  makeRow(jordan, 4.4, doc["late-fee"], { feedback: -1 });
  queryLog.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  // Chat sessions: one per user per calendar day.
  const sessions = [];
  const sessionKey = new Map();
  for (const row of queryLog) {
    const key = `${row.userId}:${row.createdAt.slice(0, 10)}`;
    let session = sessionKey.get(key);
    if (!session) {
      session = {
        id: nextId(),
        userId: row.userId,
        programId,
        title: row.question.length > 60 ? `${row.question.slice(0, 57)}...` : row.question,
        updatedAt: row.createdAt
      };
      sessionKey.set(key, session);
      sessions.push(session);
    }
    session.updatedAt = row.createdAt;
    row.sessionId = session.id;
  }

  // Reader opens. Hold and transfer etiquette is opened often but never cited.
  const views = [];
  const viewers = users.filter((u) => u.programId === programId && u.role !== "super_user" && !u.isDemo);
  const viewable = documents.filter((d) => !d.retired);
  for (let i = 0; i < 520; i += 1) {
    const user = pick(viewers);
    let d = rand() < 0.08 ? doc["hold-time"] : rand() < 0.75 ? pickDoc() : pick(viewable);
    if (d.retired || !canSee(user, d)) d = doc["id-verify"];
    const createdDays = (now - Date.parse(d.createdAt)) / DAY;
    const ageDays = rand() * Math.min(90, createdDays);
    views.push({
      userId: user.id,
      documentId: d.id,
      viewedAt: iso(now - ageDays * DAY),
      via: rand() < 0.4 ? "citation" : "browse"
    });
  }
  // Jordan's recent opens, spread over the last 10 days, so "Recently opened" has content.
  const recentOpens = [
    ["cancel-fee", 0.05],
    ["refund-annual", 0.4],
    ["id-verify", 1.2],
    ["late-fee", 2.5],
    ["roaming", 3.8],
    ["warranty", 5.5],
    ["plan-change", 7.2],
    ["autopay", 9.3]
  ];
  for (const [key, ageDays] of recentOpens) {
    views.push({ userId: jordan.id, documentId: doc[key].id, viewedAt: iso(now - ageDays * DAY), via: "browse" });
  }

  // Supervisor teams (team_members) and their recommended sources
  // (kb_team_shortcuts). Added last so every id and random draw above stays
  // the same as before supervisors existed. Renee leads Jordan, Aisha and
  // Marcus; Elliot (a demo account, so his list is read-only) leads Tomas,
  // Kim and Priya; Devon is on no team.
  const renee = mkUser("Renee Alvarez", "renee.alvarez@acme-wireless.example", "supervisor", "internal");
  const elliot = mkUser("Elliot Brooks", "demo.supervisor@truenote.example", "supervisor", "internal", {
    isDemo: true
  });
  users.push(renee, elliot);
  const teamMembers = [
    ...["jordan", "aisha", "marcus"].map((name) => ({ csrId: byName[name].id, supervisorId: renee.id, programId })),
    ...["tomas", "kim", "priya"].map((name) => ({ csrId: byName[name].id, supervisorId: elliot.id, programId }))
  ];
  const teamShortcuts = [
    ...["late-fee", "retention-offers"].map((key, position) => ({
      supervisorId: renee.id,
      programId,
      documentId: doc[key].id,
      position
    })),
    ...["plan-change", "roaming"].map((key, position) => ({
      supervisorId: elliot.id,
      programId,
      documentId: doc[key].id,
      position
    }))
  ];

  // Break-glass emergency account with a second factor (lib/auth/mfa.ts).
  // Added after every other row so the ids and random draws above stay the
  // same. Its password step returns mfaRequired; the seeded passkey is a
  // placeholder no real authenticator holds, so the first sign-in uses the
  // fixture recovery code, then a passkey added on the Security page.
  const rowan = mkUser("Rowan Hale", "emergency@truenote.example", "super_user", "restricted");
  users.push(rowan);
  const mfa = new Map([
    [
      rowan.id,
      {
        passkeys: [
          {
            id: nextId(),
            credentialId: "Zml4dHVyZS1wbGFjZWhvbGRlci1wYXNza2V5",
            transports: ["usb"],
            name: "Seeded security key (fixture placeholder)",
            createdAt: iso(daysAgo(40)),
            lastUsedAt: iso(daysAgo(12))
          }
        ],
        recoveryCodes: [{ code: "mockrecoverycode", usedAt: null }]
      }
    ]
  ]);
  return {
    programs,
    users,
    documents,
    tags,
    docTags,
    categories,
    categoryDocs,
    featured,
    teamMembers,
    teamShortcuts,
    askExamples: new Map(),
    userState,
    categoryPrefs,
    colorLabels,
    queryLog,
    sessions,
    views,
    highlights: [],
    mfa,
    // Fixture reset links (`mock-reset-<key>`) already used; see server.mjs.
    usedResetTokens: new Set(),
    colors: COLORS
  };
}
