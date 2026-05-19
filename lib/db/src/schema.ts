import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid
} from "drizzle-orm/pg-core";

// pgvector — Drizzle has no first-class vector type that we want to lock to a
// specific dimension. customType keeps the DDL source-of-truth in the
// reference data-model.md and the Replit-handoff SQL, while giving us typed
// reads/writes in TS. driverData is a pg-formatted "[n,n,...]" literal.
const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(1536)";
  },
  toDriver(value: number[]): string {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string): number[] {
    return value
      .replace(/^\[/, "")
      .replace(/\]$/, "")
      .split(",")
      .map((s) => Number(s));
  }
});

// chunks.content_tsv exists in the DB as a GENERATED ALWAYS column (see the
// DDL in REPLIT_HANDOFF.md) but is intentionally NOT declared in the Drizzle
// schema. We only ever reference it from raw SQL in lib/retrieval/query.ts;
// keeping it out of Drizzle avoids any risk that the ORM tries to handle it
// on inserts.

// --- programs

export const programs = pgTable("programs", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
});

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;

// --- documents

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id").references(() => programs.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  currentVersionId: uuid("current_version_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;

// --- document_versions

export type ParseStatus = "pending" | "parsing" | "ready" | "failed";

export const documentVersions = pgTable("document_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  sourceUrl: text("source_url"),
  mimeType: text("mime_type"),
  fileSha256: text("file_sha256"),
  parseStatus: text("parse_status").$type<ParseStatus>().default("pending"),
  parsedMarkdown: text("parsed_markdown"),
  uploadedBy: text("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow(),
  isActive: boolean("is_active").default(true)
});

export type DocumentVersion = typeof documentVersions.$inferSelect;
export type NewDocumentVersion = typeof documentVersions.$inferInsert;

// --- chunks

export interface ChunkMetadata {
  has_image?: boolean;
  image_url?: string;
  heading_path?: string[];
  token_count?: number;
}

export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  documentVersionId: uuid("document_version_id").references(() => documentVersions.id, {
    onDelete: "cascade"
  }),
  // Denormalized for fast scoping. Retrieval filters on this directly to
  // avoid the documents/document_versions join at query time. See
  // .claude/reference/data-model.md → Invariants.
  programId: uuid("program_id").notNull(),
  ordinal: integer("ordinal"),
  content: text("content").notNull(),
  // content_tsv: see file-level note. Generated in the DB, not declared here.
  embedding: vector1536("embedding"),
  metadata: jsonb("metadata").$type<ChunkMetadata>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
});

export type Chunk = typeof chunks.$inferSelect;
export type NewChunk = typeof chunks.$inferInsert;

// --- query_log

export const queryLog = pgTable("query_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id"),
  userId: text("user_id"),
  question: text("question").notNull(),
  answer: text("answer"),
  citedChunkIds: uuid("cited_chunk_ids").array(),
  refused: boolean("refused").default(false),
  latencyMs: integer("latency_ms"),
  feedback: integer("feedback"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
});

export type QueryLog = typeof queryLog.$inferSelect;
export type NewQueryLog = typeof queryLog.$inferInsert;

// --- eval_questions

export const evalQuestions = pgTable("eval_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  programId: uuid("program_id"),
  question: text("question").notNull(),
  expectedDocId: uuid("expected_doc_id"),
  expectedAnswerContains: text("expected_answer_contains").array(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow()
});

export type EvalQuestion = typeof evalQuestions.$inferSelect;
export type NewEvalQuestion = typeof evalQuestions.$inferInsert;
