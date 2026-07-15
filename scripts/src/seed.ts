/**
 * Controlled demo-corpus seed.
 *
 * Usage on Replit after the P0/P1 controls are applied:
 *   pnpm --filter @workspace/scripts run seed
 *
 * Idempotent and narrowly scoped:
 *   - reuses the existing Demo Program used by demo accounts;
 *   - creates or reactivates one approved synthetic-demo source;
 *   - replaces only the two seed-owned documents and their eval questions;
 *   - leaves demo users and unrelated program content untouched;
 *   - creates real text-embedding-3-small vectors using OPENAI_API_KEY.
 *
 * The documents are built-in synthetic text, not uploaded files. Their scan
 * status is therefore `legacy_accepted`, never a fabricated malware-clean
 * verdict. Provenance and approval fields make that exception explicit.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../artifacts/api-server/src/lib/db-client.js";
import {
  programs,
  documents,
  chunks,
  evalQuestions
} from "@workspace/db/schema";
import { OpenAIEmbedder } from "../../artifacts/api-server/src/lib/ingestion/embedder.js";
import {
  buildContextHeader,
  prependContextHeader
} from "../../artifacts/api-server/src/lib/ingestion/contextual.js";
import { sha256Hex } from "../../artifacts/api-server/src/lib/parsing/hash.js";
import { chunkMarkdown } from "../../artifacts/api-server/src/lib/parsing/chunker.js";
import { createTiktokenTokenizer } from "../../artifacts/api-server/src/lib/parsing/tokenizer.js";

const SEED_PROGRAM_ID = "00000000-0000-0000-0000-0000000000aa";
const SEED_PROGRAM_NAME = "Demo Program";
const SEED_SOURCE_NAME = "Truenote synthetic demo corpus";
const SEED_SOURCE_URI = "seed://truenote-demo";

interface SeedDoc {
  title: string;
  parsedMarkdown: string;
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
  ].join("\n")
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
  ].join("\n")
};

const SEED_DOCS: SeedDoc[] = [CANCELLATION_DOC, REFUND_DOC];

interface SeedEval {
  question: string;
  expectedDocTitle?: string;
  expectedAnswerContains: string[];
  notes?: string;
}

const SEED_EVAL_QUESTIONS: SeedEval[] = [
  {
    question: "What is the cancellation fee for the Basic plan?",
    expectedDocTitle: CANCELLATION_DOC.title,
    expectedAnswerContains: ["$5"],
    notes: "Exact-value lookup for the cancellation-fee table."
  },
  {
    question: "How much does it cost to cancel a Pro subscription?",
    expectedDocTitle: CANCELLATION_DOC.title,
    expectedAnswerContains: ["$10"]
  },
  {
    question: "Can a legacy customer be charged a cancellation fee?",
    expectedDocTitle: CANCELLATION_DOC.title,
    expectedAnswerContains: ["legacy", "exempt"]
  },
  {
    question: "How long does a refund take to post to the original card?",
    expectedDocTitle: REFUND_DOC.title,
    expectedAnswerContains: ["5-7", "business days"]
  },
  {
    question: "What state laws override the standard cancellation policy?",
    expectedDocTitle: CANCELLATION_DOC.title,
    expectedAnswerContains: ["California", "New York"]
  },
  {
    question: "Who must approve a courtesy refund?",
    expectedDocTitle: REFUND_DOC.title,
    expectedAnswerContains: ["Tier 2", "supervisor"]
  },
  {
    question: "What is the refund eligibility window?",
    expectedDocTitle: REFUND_DOC.title,
    expectedAnswerContains: ["30-day"]
  },
  {
    question: "What are the steps to issue a refund?",
    expectedDocTitle: REFUND_DOC.title,
    expectedAnswerContains: ["Verify", "billing console", "Issue Refund"]
  },
  {
    question: "How does the customer initiate a cancellation?",
    expectedDocTitle: CANCELLATION_DOC.title,
    expectedAnswerContains: ["account settings", "Cancel Subscription"]
  },
  {
    question: "What is the integration price tier for the moon-rocket plan?",
    expectedAnswerContains: [],
    notes: "Out-of-KB refusal check."
  }
];

interface PreparedChunk {
  ordinal: number;
  content: string;
  embedding: number[];
  metadata: {
    heading_path?: string[];
    token_count?: number;
    segment_types?: string[];
    source_start?: number;
    source_end?: number;
    context_header?: string;
  };
}

interface PreparedDoc {
  document: SeedDoc;
  sha256: string;
  chunks: PreparedChunk[];
}

async function prepareDocuments(): Promise<PreparedDoc[]> {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("OPENAI_API_KEY is required to create usable demo embeddings.");
  }

  const tokenize = createTiktokenTokenizer();
  const staged = SEED_DOCS.map((document) => {
    const semanticChunks = chunkMarkdown(document.parsedMarkdown, { tokenize });
    return {
      document,
      sha256: sha256Hex(Buffer.from(document.parsedMarkdown)),
      chunks: semanticChunks.map((chunk) => {
        const header = buildContextHeader(
          document.title,
          chunk.metadata.heading_path
        );
        return {
          ordinal: chunk.ordinal,
          content: prependContextHeader(header, chunk.content),
          metadata: {
            ...chunk.metadata,
            context_header: header || undefined
          }
        };
      })
    };
  });

  const flatChunks = staged.flatMap((document) => document.chunks);
  const embeddings = await new OpenAIEmbedder().embed(
    flatChunks.map((chunk) => chunk.content)
  );
  if (embeddings.length !== flatChunks.length) {
    throw new Error("Embedding count did not match the prepared demo chunks.");
  }

  let embeddingIndex = 0;
  return staged.map((document) => ({
    ...document,
    chunks: document.chunks.map((chunk) => {
      const embedding = embeddings[embeddingIndex];
      embeddingIndex += 1;
      if (!embedding || embedding.length !== 1536) {
        throw new Error(`Invalid embedding for ${document.document.title}.`);
      }
      return { ...chunk, embedding };
    })
  }));
}

async function resolveDemoProgram(): Promise<string> {
  const existing = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.name, SEED_PROGRAM_NAME))
    .limit(2);
  if (existing.length > 1) {
    throw new Error(`Multiple programs are named "${SEED_PROGRAM_NAME}"; refusing to guess.`);
  }
  if (existing[0]) return existing[0].id;

  const inserted = await db
    .insert(programs)
    .values({ id: SEED_PROGRAM_ID, name: SEED_PROGRAM_NAME })
    .returning({ id: programs.id });
  const row = inserted[0];
  if (!row) throw new Error("Failed to create Demo Program.");
  return row.id;
}

async function resolveApproverId(): Promise<string> {
  const preferredEmail = process.env.BOOTSTRAP_SUPER_USER_EMAIL?.trim().toLowerCase();
  const result = await db.execute(sql`
    SELECT id::text
    FROM users
    WHERE is_active = true
      AND role::text = 'super_user'
    ORDER BY
      CASE WHEN ${preferredEmail ?? ""} <> '' AND lower(email) = ${preferredEmail ?? ""}
        THEN 0 ELSE 1 END,
      created_at
    LIMIT 1
  `);
  const id = result.rows[0]?.["id"];
  if (typeof id !== "string") {
    throw new Error("An active super user is required to approve the demo corpus.");
  }
  return id;
}

async function main(): Promise<void> {
  const programId = await resolveDemoProgram();
  const approverId = await resolveApproverId();
  console.log(`[seed] preparing real embeddings for ${SEED_DOCS.length} demo documents`);
  const preparedDocs = await prepareDocuments();

  await db.transaction(async (tx) => {
    const sourceResult = await tx.execute(sql`
      INSERT INTO content_sources (
        program_id, name, origin_type, base_uri, owner_name, is_active,
        created_by, approved_by, approved_at, approval_basis, retired_at
      ) VALUES (
        ${programId}::uuid,
        ${SEED_SOURCE_NAME},
        'other',
        ${SEED_SOURCE_URI},
        'Truenote demo content owner',
        true,
        ${approverId}::uuid,
        ${approverId}::uuid,
        now(),
        'Built-in synthetic content approved for the public Truenote demo',
        NULL
      )
      ON CONFLICT (program_id, (lower(name))) DO UPDATE
      SET origin_type = EXCLUDED.origin_type,
          base_uri = EXCLUDED.base_uri,
          owner_name = EXCLUDED.owner_name,
          is_active = true,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          approval_basis = EXCLUDED.approval_basis,
          retired_at = NULL
      RETURNING id::text
    `);
    const sourceId = sourceResult.rows[0]?.["id"];
    if (typeof sourceId !== "string") throw new Error("Failed to create demo source.");

    const seedQuestions = SEED_EVAL_QUESTIONS.map((question) => question.question);
    await tx.delete(evalQuestions).where(
      and(
        eq(evalQuestions.programId, programId),
        inArray(evalQuestions.question, seedQuestions)
      )
    );

    const seedTitles = SEED_DOCS.map((document) => document.title);
    await tx.delete(documents).where(
      and(eq(documents.programId, programId), inArray(documents.title, seedTitles))
    );

    const documentIds = new Map<string, string>();
    for (const prepared of preparedDocs) {
      console.log(`[seed] inserting ${prepared.document.title}`);
      const insertedDocument = await tx
        .insert(documents)
        .values({ programId, title: prepared.document.title })
        .returning({ id: documents.id });
      const documentId = insertedDocument[0]?.id;
      if (!documentId) throw new Error("Failed to insert demo document.");
      documentIds.set(prepared.document.title, documentId);

      const sourceUrl = `${SEED_SOURCE_URI}/${prepared.document.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}.md`;
      const insertedVersion = await tx.execute(sql`
        INSERT INTO document_versions (
          document_id, version_number, source_url, mime_type, file_sha256,
          parse_status, parsed_markdown, uploaded_by, is_active,
          lifecycle_state, classification, source_id, source_origin_uri,
          source_owner, original_file_name, scan_status, scan_engine, scan_id,
          scan_findings, scan_completed_at, approved_by, approved_at,
          approval_notes, activated_at
        ) VALUES (
          ${documentId}::uuid,
          1,
          ${sourceUrl},
          'text/markdown',
          ${prepared.sha256},
          'ready',
          ${prepared.document.parsedMarkdown},
          'demo-seed',
          true,
          'active',
          'public',
          ${sourceId}::uuid,
          ${sourceUrl},
          'Truenote demo content owner',
          ${prepared.document.title + ".md"},
          'legacy_accepted',
          'truenote-demo-seed',
          ${`synthetic-${prepared.sha256}`},
          '[]'::jsonb,
          now(),
          ${approverId}::uuid,
          now(),
          'Built-in synthetic demo content; no external upload was processed',
          now()
        )
        RETURNING id::text
      `);
      const versionId = insertedVersion.rows[0]?.["id"];
      if (typeof versionId !== "string") {
        throw new Error("Failed to insert demo document version.");
      }

      await tx
        .update(documents)
        .set({ currentVersionId: versionId })
        .where(eq(documents.id, documentId));

      await tx.insert(chunks).values(
        prepared.chunks.map((chunk) => ({
          documentVersionId: versionId,
          programId,
          ordinal: chunk.ordinal,
          content: chunk.content,
          embedding: chunk.embedding,
          metadata: chunk.metadata
        }))
      );
      console.log(`[seed]   ${prepared.chunks.length} chunks`);
    }

    await tx.insert(evalQuestions).values(
      SEED_EVAL_QUESTIONS.map((question) => ({
        programId,
        question: question.question,
        expectedDocId: question.expectedDocTitle
          ? documentIds.get(question.expectedDocTitle)
          : undefined,
        expectedAnswerContains: question.expectedAnswerContains,
        notes: question.notes
      }))
    );
  });

  console.log(
    `[seed] restored ${SEED_DOCS.length} documents and ${SEED_EVAL_QUESTIONS.length} eval questions in ${SEED_PROGRAM_NAME}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("[seed] failed:", error);
    process.exit(1);
  });
