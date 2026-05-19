/**
 * Demo seed.
 *
 * Usage on Replit (after pnpm install + the DDL block):
 *   DATABASE_URL=... pnpm --filter @workspace/scripts run seed
 *
 * Idempotent — wipes the demo program scope and reinserts.
 *
 * IMPORTANT FLAG: chunks here have ALL-ZERO embeddings. They will return
 * NaN distances for vector queries and therefore rank unpredictably. The
 * BM25 path still works, so end-to-end retrieval is testable through the
 * lexical channel only. Replace with real embeddings (run a real upload
 * through the ingestion worker) before judging retrieval quality.
 */

import { eq } from "drizzle-orm";
import { db } from "../../artifacts/api-server/src/lib/db-client.js";
import {
  programs,
  documents,
  documentVersions,
  chunks,
  evalQuestions
} from "@workspace/db/schema";
import { sha256Hex } from "../../artifacts/api-server/src/lib/parsing/hash.js";

const SEED_PROGRAM_ID = "00000000-0000-0000-0000-0000000000aa";
const SEED_PROGRAM_NAME = "Demo Program";
const ZERO_EMBEDDING: number[] = Array.from({ length: 1536 }, () => 0);

interface SeedChunk {
  ordinal: number;
  content: string;
}

interface SeedDoc {
  title: string;
  parsedMarkdown: string;
  chunks: SeedChunk[];
}

const CANCELLATION_DOC: SeedDoc = {
  title: "Cancellation Policy v1",
  parsedMarkdown: [
    "# Cancellation Policy",
    "",
    "Customers may cancel any subscription plan within 30 days of purchase",
    "for a full refund. After 30 days, the standard cancellation fee applies.",
    "",
    "## Standard Fees",
    "",
    "| Plan | Cancellation Fee |",
    "| --- | --- |",
    "| Basic | $5 |",
    "| Pro | $10 |",
    "| Enterprise | $25 |",
    "",
    "## Exceptions",
    "",
    "Legacy customers (signed before 2022-01-01) are exempt from all",
    "cancellation fees regardless of plan.",
    "",
    "Customers in California and New York may cancel at any time without",
    "fee under state consumer-protection law.",
    "",
    "## How to Cancel",
    "",
    "1. Open the account settings page.",
    "2. Click Cancel Subscription.",
    "3. Confirm the cancellation reason.",
    "4. Receive a confirmation email within 24 hours."
  ].join("\n"),
  chunks: [
    {
      ordinal: 0,
      content:
        "# Cancellation Policy\n\nCustomers may cancel any subscription plan within 30 days of purchase for a full refund. After 30 days, the standard cancellation fee applies."
    },
    {
      ordinal: 1,
      content:
        "## Standard Fees\n\n| Plan | Cancellation Fee |\n| --- | --- |\n| Basic | $5 |\n| Pro | $10 |\n| Enterprise | $25 |"
    },
    {
      ordinal: 2,
      content:
        "## Exceptions\n\nLegacy customers (signed before 2022-01-01) are exempt from all cancellation fees regardless of plan."
    },
    {
      ordinal: 3,
      content:
        "Customers in California and New York may cancel at any time without fee under state consumer-protection law."
    },
    {
      ordinal: 4,
      content:
        "## How to Cancel\n\n1. Open the account settings page.\n2. Click Cancel Subscription.\n3. Confirm the cancellation reason.\n4. Receive a confirmation email within 24 hours."
    }
  ]
};

const REFUND_DOC: SeedDoc = {
  title: "Refund Procedure v1",
  parsedMarkdown: [
    "# Refund Procedure",
    "",
    "Use this procedure for any customer requesting a refund on a paid plan.",
    "",
    "## Eligibility",
    "",
    "- Customer is within the 30-day refund window.",
    "- Payment has cleared (not on a pending authorization).",
    "- Customer has not previously been refunded for the same charge.",
    "",
    "## Procedure",
    "",
    "1. Verify the customer's identity using two factors.",
    "2. Pull up the most recent charge in the billing console.",
    "3. Click Issue Refund.",
    "4. Select Full or Partial.",
    "5. Add a one-line reason code.",
    "6. Submit. The refund posts to the original card within 5-7 business days.",
    "",
    "## Escalation",
    "",
    "If the customer disputes the amount or the refund window, escalate to",
    "a Tier 2 supervisor. Do NOT issue a courtesy refund without approval."
  ].join("\n"),
  chunks: [
    {
      ordinal: 0,
      content:
        "# Refund Procedure\n\nUse this procedure for any customer requesting a refund on a paid plan."
    },
    {
      ordinal: 1,
      content:
        "## Eligibility\n\n- Customer is within the 30-day refund window.\n- Payment has cleared (not on a pending authorization).\n- Customer has not previously been refunded for the same charge."
    },
    {
      ordinal: 2,
      content:
        "## Procedure\n\n1. Verify the customer's identity using two factors.\n2. Pull up the most recent charge in the billing console.\n3. Click Issue Refund.\n4. Select Full or Partial.\n5. Add a one-line reason code."
    },
    {
      ordinal: 3,
      content:
        "Submit. The refund posts to the original card within 5-7 business days."
    },
    {
      ordinal: 4,
      content:
        "## Escalation\n\nIf the customer disputes the amount or the refund window, escalate to a Tier 2 supervisor. Do NOT issue a courtesy refund without approval."
    }
  ]
};

const SEED_DOCS: SeedDoc[] = [CANCELLATION_DOC, REFUND_DOC];

interface SeedEval {
  question: string;
  expectedAnswerContains: string[];
  notes?: string;
}

const SEED_EVAL_QUESTIONS: SeedEval[] = [
  {
    question: "What is the cancellation fee for the Basic plan?",
    expectedAnswerContains: ["$5"],
    notes: "exact-match lookup; BM25 should hit"
  },
  {
    question: "How much does it cost to cancel a Pro subscription?",
    expectedAnswerContains: ["$10"]
  },
  {
    question: "Can a legacy customer be charged a cancellation fee?",
    expectedAnswerContains: ["legacy", "exempt"]
  },
  {
    question: "How long does a refund take to post to the original card?",
    expectedAnswerContains: ["5-7", "business days"]
  },
  {
    question: "What state laws override the standard cancellation policy?",
    expectedAnswerContains: ["California", "New York"]
  },
  {
    question: "Who must approve a courtesy refund?",
    expectedAnswerContains: ["Tier 2", "supervisor"]
  },
  {
    question: "What is the refund eligibility window?",
    expectedAnswerContains: ["30-day"]
  },
  {
    question: "What are the steps to issue a refund?",
    expectedAnswerContains: ["Verify", "billing console", "Issue Refund"]
  },
  {
    question: "How does the customer initiate a cancellation?",
    expectedAnswerContains: ["account settings", "Cancel Subscription"]
  },
  {
    question: "What is the integration price tier for the moon-rocket plan?",
    expectedAnswerContains: [],
    notes: "Out-of-KB sanity check — should refuse, never invent"
  }
];

async function main(): Promise<void> {
  console.log(`[seed] resetting program ${SEED_PROGRAM_ID}`);
  await db.delete(evalQuestions).where(eq(evalQuestions.programId, SEED_PROGRAM_ID));
  // documents cascades to document_versions cascades to chunks (FK ON DELETE CASCADE).
  await db.delete(documents).where(eq(documents.programId, SEED_PROGRAM_ID));
  await db.delete(programs).where(eq(programs.id, SEED_PROGRAM_ID));

  console.log("[seed] inserting program");
  await db.insert(programs).values({ id: SEED_PROGRAM_ID, name: SEED_PROGRAM_NAME });

  for (const doc of SEED_DOCS) {
    console.log(`[seed] inserting document: ${doc.title}`);
    const fakeBytes = Buffer.from(doc.parsedMarkdown);
    const sha = sha256Hex(fakeBytes);

    const insertedDoc = await db
      .insert(documents)
      .values({ programId: SEED_PROGRAM_ID, title: doc.title })
      .returning({ id: documents.id });
    const docRow = insertedDoc[0];
    if (!docRow) throw new Error("Failed to insert document");

    const insertedVersion = await db
      .insert(documentVersions)
      .values({
        documentId: docRow.id,
        versionNumber: 1,
        sourceUrl: `seed://${doc.title}`,
        mimeType: "text/markdown",
        fileSha256: sha,
        parseStatus: "ready",
        parsedMarkdown: doc.parsedMarkdown,
        uploadedBy: "seed",
        isActive: true
      })
      .returning({ id: documentVersions.id });
    const versionRow = insertedVersion[0];
    if (!versionRow) throw new Error("Failed to insert document version");

    await db
      .update(documents)
      .set({ currentVersionId: versionRow.id })
      .where(eq(documents.id, docRow.id));

    // ZERO embeddings — see the file-level flag. Vector search rank is
    // undefined; BM25 still works for sanity-checking the pipeline.
    await db.insert(chunks).values(
      doc.chunks.map((c) => ({
        documentVersionId: versionRow.id,
        programId: SEED_PROGRAM_ID,
        ordinal: c.ordinal,
        content: c.content,
        embedding: ZERO_EMBEDDING,
        metadata: { token_count: Math.ceil(c.content.length / 4) }
      }))
    );
    console.log(`[seed]   ${doc.chunks.length} chunks`);
  }

  console.log(`[seed] inserting ${SEED_EVAL_QUESTIONS.length} eval questions`);
  await db.insert(evalQuestions).values(
    SEED_EVAL_QUESTIONS.map((q) => ({
      programId: SEED_PROGRAM_ID,
      question: q.question,
      expectedAnswerContains: q.expectedAnswerContains,
      notes: q.notes
    }))
  );

  console.log("[seed] done");
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error("[seed] failed:", err);
    process.exit(1);
  });
