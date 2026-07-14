import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { users } from "@workspace/db/schema";
import { db } from "../lib/db-client.js";
import {
  codeChallenge,
  createOidcState,
  getOidcConfig,
  loadOidcDiscovery,
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
import { recordSecurityEvent } from "../lib/security/audit.js";

export const oidcRouter = Router();

const STATE_COOKIE = "truenote_oidc_state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function clearStateCookie(res: import("express").Response): void {
  res.clearCookie(STATE_COOKIE, { path: "/api/auth/oidc" });
}

function redirectWithError(res: import("express").Response): void {
  res.redirect(302, "/login?sso_error=1");
}

oidcRouter.get("/start", async (req, res) => {
  try {
    const config = getOidcConfig();
    if (!config.enabled) {
      res.status(503).json({ error: "Company SSO is not fully configured." });
      return;
    }
    const discovery = await loadOidcDiscovery(config);
    const state = createOidcState(safeReturnTo(req.query.returnTo));
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
    res.redirect(302, authorization.toString());
  } catch (error) {
    console.warn("[oidc] start failed:", error instanceof Error ? error.message : error);
    redirectWithError(res);
  }
});

oidcRouter.get("/callback", async (req, res) => {
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
      discovery
    });
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        programId: users.programId,
        isActive: users.isActive
      })
      .from(users)
      .where(eq(users.email, identity.email))
      .limit(1);
    const user = rows[0];
    if (!user?.isActive) throw new Error("OIDC identity has no active Truenote account");

    const created = await createSession(user.id);
    sessionToken = created.token;
    await db.execute(sql`
      UPDATE sessions
      SET auth_method = 'oidc', auth_time = now()
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
      sourceIp: clientIpFrom(req),
      details: { issuer: discovery.issuer, authMethod: "oidc" }
    });
    setSessionCookie(res, created.token);
    res.redirect(302, state.returnTo);
  } catch (error) {
    if (sessionToken) await deleteSessionByToken(sessionToken).catch(() => undefined);
    console.warn("[oidc] callback failed:", error instanceof Error ? error.message : error);
    redirectWithError(res);
  }
});
