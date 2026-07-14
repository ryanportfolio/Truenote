import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import {
  SecurityControlsNotReadyError,
  translateSecuritySchemaError
} from "./errors.js";

export const CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "restricted"
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

const CLASSIFICATION_RANK: Record<Classification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3
};

export function parseClassification(value: unknown): Classification | null {
  return typeof value === "string" &&
    (CLASSIFICATIONS as readonly string[]).includes(value)
    ? (value as Classification)
    : null;
}

export function classificationRank(value: Classification): number {
  return CLASSIFICATION_RANK[value];
}

export function canReadClassification(
  clearance: Classification,
  classification: Classification
): boolean {
  return classificationRank(classification) <= classificationRank(clearance);
}

/**
 * Clearance stays server-owned. The client never supplies it and every
 * retrieval/read request resolves it from the authenticated user row.
 */
export async function getUserMaxClassification(
  userId: string
): Promise<Classification> {
  try {
    const result = await db.execute(sql`
      SELECT max_classification
      FROM users
      WHERE id = ${userId}::uuid
        AND is_active = true
      LIMIT 1
    `);
    const value = parseClassification(result.rows[0]?.["max_classification"]);
    if (!value) {
      throw new SecurityControlsNotReadyError(
        "Your account has no valid data-classification clearance. Contact an administrator."
      );
    }
    return value;
  } catch (error) {
    translateSecuritySchemaError(error);
  }
}

/** Shared SQL predicate fragment. `classificationColumn` must be trusted code. */
export function classificationSqlPredicate(
  classificationColumn: SQL,
  clearance: Classification
) {
  const rank = classificationRank(clearance);
  return sql`
    CASE ${classificationColumn}
      WHEN 'public' THEN 0
      WHEN 'internal' THEN 1
      WHEN 'confidential' THEN 2
      WHEN 'restricted' THEN 3
      ELSE 99
    END <= ${rank}
  `;
}
