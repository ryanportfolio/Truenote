import { Router } from "express";
import { eq, sql, type SQL } from "drizzle-orm";
import { users, type User } from "@workspace/db/schema";
import { db } from "../lib/db-client.js";
import {
  findIdentityBySubject,
  linkIdentity,
  recordIdentityLogin,
  userHasIdentityForIssuer
} from "../lib/auth/identities.js";
import {
  codeChallenge,
  createOidcState,
  getOidcConfig,
  loadOidcDiscovery,
  OidcReauthError,
  openOidcState,
  safeReturnTo,
  sealOidcState,
  verifyOidcIdToken
} from "../lib/auth/oidc.js";
import {
  createSession,
  deleteSessionByToken,
  hashToken,
  setSessionCookie
} from "../lib/auth/sessions.js";
import { clientIpFrom } from "../lib/auth/rate-limit.js";
import { getSsoSessionMaxHours } from "../lib/auth/session-policy.js";
import { clearIdleReauth, isIdleReauthRequired } from "../lib/auth/idle-reauth.js";
import {
  recordSecurityEvent,
  recordSecurityEventBestEffort
} from "../lib/security/audit.js";
import { oidcIpLimit } from "../lib/security/route-rate-limit.js";

export const oidcRouter = Router();

type OidcUser = Pick<User, "id" | "email" | "role" | "programId" | "isActive">;

/** A policy refusal; `reason` is the short code recorded in the audit event. */
class OidcRefusal extends Error {
  constructor(readonly reason: string, readonly user?: OidcUser) {
    super(`OIDC login refused: ${reason}`);
  }
}

async function loadUser(where: SQL): Promise<OidcUser | undefined> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      programId: users.programId,
      isActive: users.isActive
    })
    .from(users)
    .where(where)
    .limit(1);
  return rows[0];
}

/**
 * Checked on every SSO login, before any session exists. Users without a
 * program (super_user) cannot use SSO; their access goes through local login.
 */
function assertEligible(user: OidcUser, allowedProgramIds: string[]): void {
  if (!user.isActive) throw new OidcRefusal("inactive", user);
  if (!user.programId || !allowedProgramIds.includes(user.programId.toLowerCase())) {
    throw new OidcRefusal("program_not_allowed", user);
  }
}

const STATE_COOKIE = "truenote_oidc_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function clearStateCookie(res: import("express").Response): void {
  res.clearCookie(STATE_COOKIE, { path: "/api/auth/oidc" });
}

function redirectWithError(res: import("express").Response): void {
  res.redirect(302, "/login?sso_error=1");
}

oidcRouter.get("/start", oidcIpLimit, async (req, res) => {
  try {
    const config = getOidcConfig();
    if (!config.enabled) {
      res.status(503).json({ error: "Company SSO is not fully configured." });
      return;
    }
    const discovery = await loadOidcDiscovery(config);
    // After an idle expiry Entra must ask for credentials again; a silent
    // SSO sign-in is not re-authentication (PCI DSS 8.2.8).
    const reauthenticate = isIdleReauthRequired(req, res);
    const state = createOidcState(safeReturnTo(req.query.returnTo), { reauthenticate });
    res.cookie(STATE_COOKIE, sealOidcState(state, config.stateSecret), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: STATE_MAX_AGE_MS,
      path: "/api/auth/oidc"
    });
    const authorization = new URL(discovery.authorization_endpoint);
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("redirect_uri", config.redirectUri);
    authorization.searchParams.set("scope", "openid profile email");
    authorization.searchParams.set("state", state.state);
    authorization.searchParams.set("nonce", state.nonce);
    authorization.searchParams.set("code_challenge", codeChallenge(state.codeVerifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    if (reauthenticate) authorization.searchParams.set("prompt", "login");
    res.redirect(302, authorization.toString());
  } catch (error) {
    console.warn("[oidc] start failed:", error instanceof Error ? error.message : error);
    redirectWithError(res);
  }
});

oidcRouter.get("/callback", oidcIpLimit, async (req, res) => {
  const sealed = typeof req.cookies?.[STATE_COOKIE] === "string"
    ? req.cookies[STATE_COOKIE]
    : "";
  clearStateCookie(res);
  let sessionToken: string | null = null;
  try {
    const config = getOidcConfig();
    if (!config.enabled) throw new Error("OIDC is not fully configured");
    const state = openOidcState(sealed, config.stateSecret);
    if (!state || req.query.state !== state.state || typeof req.query.code !== "string") {
      throw new Error("OIDC callback state is invalid or expired");
    }
    if (state.authenticatedAfter === undefined && isIdleReauthRequired(req, res)) {
      // The session ended after an unforced /start (for example it idled
      // out while the user was at Entra). Restart so Entra is sent
      // prompt=login; /start now sees the requirement, so this cannot loop.
      res.redirect(302, `/api/auth/oidc/start?returnTo=${encodeURIComponent(state.returnTo)}`);
      return;
    }
    const discovery = await loadOidcDiscovery(config);
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: req.query.code,
        redirect_uri: config.redirectUri,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code_verifier: state.codeVerifier
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!tokenResponse.ok) {
      throw new Error(`OIDC token endpoint returned HTTP ${tokenResponse.status}`);
    }
    const tokens = (await tokenResponse.json()) as { id_token?: unknown };
    if (typeof tokens.id_token !== "string") throw new Error("OIDC response has no id_token");
    const identity = await verifyOidcIdToken({
      idToken: tokens.id_token,
      nonce: state.nonce,
      config,
      discovery,
      authenticatedAfter: state.authenticatedAfter
    });
    const issuer = discovery.issuer;
    const sourceIp = clientIpFrom(req);
    const bound = await findIdentityBySubject(issuer, identity.subject);
    let user: OidcUser | undefined;
    if (bound) {
      // Later logins: the binding decides the account. The token's email
      // claims are mutable and play no part here.
      user = await loadUser(eq(users.id, bound.userId));
      if (!user) throw new OidcRefusal("no_account");
      assertEligible(user, config.allowedProgramIds);
      await recordIdentityLogin(bound.id);
    } else {
      // First login: an existing account is matched once by email, then bound.
      user = await loadUser(eq(users.email, identity.email));
      if (!user) throw new OidcRefusal("no_account");
      if (identity.claims.xms_edov === false || identity.claims.xms_edov === "false") {
        throw new OidcRefusal("email_domain_unverified", user);
      }
      assertEligible(user, config.allowedProgramIds);
      if (await userHasIdentityForIssuer(user.id, issuer)) {
        throw new OidcRefusal("already_bound", user);
      }
      const linked = await linkIdentity(
        {
          userId: user.id,
          issuer,
          subject: identity.subject,
          tenantId: identity.tenantId,
          objectId: identity.objectId
        },
        {
          action: "auth.oidc.identity_linked",
          outcome: "success",
          actor: { id: user.id, email: user.email, role: user.role },
          programId: user.programId,
          sourceIp,
          details: { issuer }
        }
      );
      if (!linked) throw new OidcRefusal("link_conflict", user);
    }

    const created = await createSession(user.id);
    sessionToken = created.token;
    // An SSO session ends SSO_SESSION_MAX_HOURS after sign-in, whatever
    // the activity; the cookie lifetime below matches it.
    const maxHours = getSsoSessionMaxHours();
    await db.execute(sql`
      UPDATE sessions
      SET auth_method = 'oidc',
          auth_time = now(),
          expires_at = now() + make_interval(hours => ${maxHours}::int)
      WHERE token_hash = ${hashToken(created.token)}
    `);
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        mustResetPassword: false,
        ...(identity.name ? { name: identity.name } : {})
      })
      .where(eq(users.id, user.id));
    await recordSecurityEvent({
      action: "auth.oidc.login",
      outcome: "success",
      actor: { id: user.id, email: user.email, role: user.role },
      programId: user.programId,
      resourceType: "session",
      sourceIp,
      details: { issuer, authMethod: "oidc" }
    });
    setSessionCookie(res, created.token, { maxAgeMs: maxHours * 60 * 60 * 1000 });
    clearIdleReauth(res);
    res.redirect(302, state.returnTo);
  } catch (error) {
    if (sessionToken) await deleteSessionByToken(sessionToken).catch(() => undefined);
    if (error instanceof OidcRefusal) {
      recordSecurityEventBestEffort({
        action: "auth.oidc.login",
        outcome: "denied",
        actor: error.user
          ? { id: error.user.id, email: error.user.email, role: error.user.role }
          : null,
        programId: error.user?.programId ?? null,
        resourceType: "session",
        sourceIp: clientIpFrom(req),
        details: { reason: error.reason, authMethod: "oidc" }
      });
    } else if (error instanceof OidcReauthError) {
      // The token was valid but not fresh; no account is resolved yet.
      recordSecurityEventBestEffort({
        action: "auth.oidc.login",
        outcome: "denied",
        actor: null,
        programId: null,
        resourceType: "session",
        sourceIp: clientIpFrom(req),
        details: { reason: `reauth_${error.reason}`, authMethod: "oidc" }
      });
    }
    console.warn("[oidc] callback failed:", error instanceof Error ? error.message : error);
    redirectWithError(res);
  }
});
