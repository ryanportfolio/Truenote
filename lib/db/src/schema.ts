import {
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn
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

// Drizzle has no first-class `citext` type. customType lets us emit the right
// DDL in the reference SQL while giving us `string` reads/writes in TS.
// Lookups against `users.email` automatically benefit from case-insensitive
// comparison on the DB side.
const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  }
});

// --- user roles

// The 4-tier role hierarchy. Capability matrix lives in CLAUDE.md / the auth
// reference; this enum is the database-side enforcement of the set of valid
// values. Order in the array IS the on-disk enum order — appending only.
export const userRoleEnum = pgEnum("user_role", [
  "super_user",
  "senior_manager",
  "manager",
  "csr"
]);

export type UserRole = (typeof userRoleEnum.enumValues)[number];

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

// --- users
//
// A users.program_id of NULL is reserved for super_user; every other role
// requires a non-null program_id. The DB enforces this with a CHECK
// constraint (see the schema-handoff DDL); we mirror the nullability in the
// type system so a TS query result correctly carries `programId: string |
// null`. Callers MUST handle the null branch — typically by rejecting
// program-scoped operations for super_user or routing them through a
// program-picker (Phase 2C).
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull(),
  programId: uuid("program_id").references(() => programs.id, {
    onDelete: "restrict"
  }),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  mustResetPassword: boolean("must_reset_password").notNull().default(true),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Self-reference: nullable so the bootstrap super_user (no creator) has
  // created_by IS NULL. Every other user must be created by some existing
  // user, but ON DELETE SET NULL keeps audit rows alive when the creator is
  // later deleted. The FK is declared in the Drizzle binding (and matches
  // the live DDL) so a future migration or schema diff sees consistent
  // truth on both sides. The AnyPgColumn annotation is Drizzle's pattern
  // for self-references — without it TS can't resolve `users.id` inside
  // the initializer of `users` itself.
  createdBy: uuid("created_by").references(
    (): AnyPgColumn => users.id,
    { onDelete: "set null" }
  )
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// --- sessions
//
// Server-stored sessions for instant revocation. The cookie carries an
// opaque high-entropy token; we store its SHA-256 hash, so a DB leak does
// not yield active sessions on its own. Sessions are looked up on every
// authenticated request — the hot path is `WHERE token_hash = ? AND
// expires_at > now()` which is index-covered.
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true })
    .notNull()
    .defaultNow()
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
