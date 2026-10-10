import { sql, type SQL } from "drizzle-orm";
import { db } from "../db-client.js";
import { appendSecurityEvent, type SecurityEventInput } from "../security/audit.js";

/**
 * OIDC account bindings in `user_identities` (lib/db/sql/0012_user_identities.sql).
 * The table is not bound in Drizzle, so every query here is raw SQL.
 */

export interface UserIdentity {
  id: string;
  userId: string;
}

export interface NewUserIdentity {
  userId: string;
  issuer: string;
  subject: string;
  tenantId: string | null;
  objectId: string | null;
}

type SqlExecutor = {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
};

function toIdentity(row: unknown): UserIdentity | null {
  const value = row as { id?: unknown; user_id?: unknown } | undefined;
  if (typeof value?.id !== "string" || typeof value.user_id !== "string") return null;
  return { id: value.id, userId: value.user_id };
}

/** The binding for an IdP account, keyed only on its stable (issuer, subject). */
export async function findIdentityBySubject(
  issuer: string,
  subject: string
): Promise<UserIdentity | null> {
  const result = await db.execute(sql`
    SELECT id::text AS id, user_id::text AS user_id
    FROM user_identities
    WHERE issuer = ${issuer} AND subject = ${subject}
    LIMIT 1
  `);
  return toIdentity(result.rows[0]);
}

/** True when the user already has a binding (to any subject) at this issuer. */
export async function userHasIdentityForIssuer(
  userId: string,
  issuer: string
): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 AS found
    FROM user_identities
    WHERE user_id = ${userId}::uuid AND issuer = ${issuer}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

/**
 * Create the first binding and its audit event in one transaction. Returns
 * null, writing nothing, when either unique constraint already holds a row:
 * the IdP account is bound to someone, or the user is bound to another
 * subject at this issuer (for example after a concurrent first login).
 */
export async function linkIdentity(
  identity: NewUserIdentity,
  event: SecurityEventInput
): Promise<UserIdentity | null> {
  return db.transaction(async (tx) => {
    const executor = tx as unknown as SqlExecutor;
    const result = await executor.execute(sql`
      INSERT INTO user_identities (user_id, issuer, subject, tenant_id, object_id, last_login_at)
      VALUES (
        ${identity.userId}::uuid,
        ${identity.issuer},
        ${identity.subject},
        ${identity.tenantId},
        ${identity.objectId},
        now()
      )
      ON CONFLICT DO NOTHING
      RETURNING id::text AS id, user_id::text AS user_id
    `);
    const linked = toIdentity(result.rows[0]);
    if (!linked) return null;
    await appendSecurityEvent(
      { ...event, resourceType: "user_identity", resourceId: linked.id },
      executor
    );
    return linked;
  });
}

export async function recordIdentityLogin(identityId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_identities SET last_login_at = now() WHERE id = ${identityId}::uuid
  `);
}
