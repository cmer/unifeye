import { and, eq, isNull, lt } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as oidc from "openid-client";
import { audit } from "../audit";
import type { Policy } from "../authz/policy";
import { config, groupsClaim } from "../config";
import { schema, type Db } from "../db";
import { decrypt, hashToken, HttpError, log, newId, randomToken } from "../util";
import { claimValues, recordProviderGroups } from "./claims";
import type { Sessions, SessionRow } from "./session";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
export const LOGIN_TXN_COOKIE = "unifeye_login";
const TXN_TTL_MS = 10 * 60_000;

export class AdmissionError extends Error {
  constructor(public reason: string) { super(reason); }
}

/** Only same-site relative paths survive; anything else becomes "/". Stops open redirects. */
export function safeReturnTo(v: string | null | undefined): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || v.includes("\n") || v.startsWith("/api/")) return "/";
  return v;
}

/**
 * OpenID Connect: the only way to sign in. Works with any standards-compliant provider. Authorization Code + PKCE (S256) with a server-side
 * exchange. Endpoints and signing keys come from discovery on the configured issuer.
 * There is no local account, password or fallback path anywhere in this application.
 */
export class Oidc {
  private cfg?: { at: number; value: Promise<oidc.Configuration> };
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  constructor(private db: Db, private policy: Policy, private sessions: Sessions) {}

  private redirectUri() { return new URL("/api/auth/callback", config().APP_URL).toString(); }
  private postLogoutUri() { return new URL("/signed-out", config().APP_URL).toString(); }

  /** Discovery result, cached for ten minutes. A failure is not cached, so recovery is automatic. */
  async configuration(): Promise<oidc.Configuration> {
    const c = config();
    if (!c.OIDC_ISSUER || !c.OIDC_CLIENT_ID) throw new HttpError(503, "sso_not_configured", "Single sign-on is not configured");
    if (this.cfg && Date.now() - this.cfg.at < 600_000) return this.cfg.value;
    const insecure = c.OIDC_ALLOW_INSECURE_ISSUER && c.NODE_ENV !== "production";
    const value = oidc.discovery(new URL(c.OIDC_ISSUER), c.OIDC_CLIENT_ID, undefined, c.OIDC_CLIENT_SECRET ? oidc.ClientSecretBasic(c.OIDC_CLIENT_SECRET) : oidc.None(), insecure ? { execute: [oidc.allowInsecureRequests] } : undefined);
    this.cfg = { at: Date.now(), value };
    value.catch(() => { this.cfg = undefined; });
    return value;
  }

  private keys(cfg: oidc.Configuration) {
    const uri = cfg.serverMetadata().jwks_uri;
    if (!uri) throw new HttpError(503, "sso_not_configured");
    return (this.jwks ??= createRemoteJWKSet(new URL(uri)));
  }

  /** Step 1: create a single-use login transaction and return the hosted-login URL. */
  async begin(returnTo: string | null): Promise<{ url: string; cookie: string }> {
    const c = config(), cfg = await this.configuration();
    const cookie = randomToken(), state = oidc.randomState(), nonce = oidc.randomNonce(), codeVerifier = oidc.randomPKCECodeVerifier();
    const t = Date.now();
    this.db.delete(schema.loginTransactions).where(lt(schema.loginTransactions.expiresAt, t)).run();
    this.db.insert(schema.loginTransactions).values({ id: hashToken(cookie), state, nonce, codeVerifier, returnTo: safeReturnTo(returnTo), createdAt: t, expiresAt: t + TXN_TTL_MS }).run();
    const scopes = new Set(c.OIDC_SCOPES.split(/\s+/).filter(Boolean));
    scopes.add("openid");
    const url = oidc.buildAuthorizationUrl(cfg, { ...Object.fromEntries(c.OIDC_AUTH_PARAMS), redirect_uri: this.redirectUri(), scope: [...scopes].join(" "), state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier), code_challenge_method: "S256", response_type: "code" });
    return { url: url.toString(), cookie };
  }

  /**
   * Step 2: the redirect back from the provider. Order matters:
   *  consume the transaction first (so a replayed callback always fails), then exchange the code
   *  server-side with PKCE, state and nonce checks, then apply admission rules, then map the
   *  exact (issuer, subject) pair to a profile, and only then create a rotated session.
   */
  async complete(currentUrl: URL, txnCookie: string | undefined, ctx: { userAgent?: string; ip?: string; previousSessionToken?: string }) {
    const c = config();
    const fail = (reason: string, detail?: Record<string, unknown>): never => {
      audit(this.db, { action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { reason, ...detail } });
      log("warn", "sign-in refused", { reason, ...detail }); // so a misconfigured provider can be diagnosed without signing in
      throw new AdmissionError(reason);
    };
    if (!txnCookie) fail("no_transaction");
    const id = hashToken(txnCookie!), t = Date.now();
    const used = this.db.update(schema.loginTransactions).set({ consumedAt: t }).where(and(eq(schema.loginTransactions.id, id), isNull(schema.loginTransactions.consumedAt))).run().changes;
    const txn = this.db.select().from(schema.loginTransactions).where(eq(schema.loginTransactions.id, id)).get();
    if (!used || !txn) fail("transaction_replayed_or_unknown");
    if (t >= txn!.expiresAt) fail("transaction_expired");

    const cfg = await this.configuration();
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try {
      tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, { pkceCodeVerifier: txn!.codeVerifier, expectedState: txn!.state, expectedNonce: txn!.nonce, idTokenExpected: true });
    } catch (e) {
      return fail("token_validation_failed", { error: (e as Error).message });
    }
    const claims = tokens.claims();
    if (!claims || !tokens.id_token) return fail("no_id_token");
    // openid-client trusts an ID token that arrives directly from the token endpoint over TLS and
    // does not check its signature. Unifeye verifies it explicitly against the issuer's keys.
    try {
      await jwtVerify(tokens.id_token, this.keys(cfg), { issuer: cfg.serverMetadata().issuer, audience: c.OIDC_CLIENT_ID!, clockTolerance: 30 });
    } catch (e) {
      return fail("token_validation_failed", { error: (e as Error).message });
    }
    // The library has verified signature, iss, aud, exp and nonce. These repeat the essentials explicitly.
    if (claims.iss !== cfg.serverMetadata().issuer || claims.iss !== c.OIDC_ISSUER!.replace(/\/$/, "") && claims.iss !== c.OIDC_ISSUER) fail("unexpected_issuer");
    if (!claims.sub) fail("no_subject");

    // Admission: authenticating at the issuer is not enough. When a claim is configured, the ID
    // token must carry it, with one of the accepted values if any are listed.
    if (c.OIDC_ADMIT_CLAIM) {
      const have = claimValues(claims, c.OIDC_ADMIT_CLAIM);
      const ok = c.OIDC_ADMIT_VALUES.length ? have.some((v) => c.OIDC_ADMIT_VALUES.includes(v)) : have.length > 0;
      if (!ok) fail("not_admitted", { sub: claims.sub, claim: c.OIDC_ADMIT_CLAIM });
    }

    const iss = claims.iss, sub = claims.sub;
    const name = typeof claims.name === "string" && claims.name ? claims.name : typeof claims.preferred_username === "string" ? claims.preferred_username : "";
    const email = typeof claims.email === "string" ? claims.email : null;
    // Identity is the exact (issuer, subject) pair. Email is never used to find or link an account.
    let policyChanged = false;
    const user = this.db.transaction((tx) => {
      let u = tx.select().from(schema.users).where(and(eq(schema.users.issuer, iss), eq(schema.users.subject, sub))).get();
      if (!u) {
        // First admitted sign-in: a profile with no cameras, no groups and no administrator rights.
        const row = { id: newId(), issuer: iss, subject: sub, email, name, role: "staff" as const, status: "active" as const, allowPrivateViews: false, providerGroups: [] as string[], createdAt: t, updatedAt: t, lastLoginAt: null, version: 1 };
        tx.insert(schema.users).values(row).run();
        u = row;
        policyChanged = true;
        audit(this.db, { actorId: u.id, action: "user.provisioned", targetType: "user", targetId: u.id, ip: ctx.ip });
      }
      // One-time bootstrap of the first administrator, by exact issuer + subject from deployment config.
      const done = tx.select().from(schema.settings).where(eq(schema.settings.key, "bootstrap_admin_done")).get();
      if (!done && c.BOOTSTRAP_ADMIN_ISSUER === iss && c.BOOTSTRAP_ADMIN_SUBJECT === sub) {
        tx.update(schema.users).set({ role: "admin", updatedAt: t }).where(eq(schema.users.id, u.id)).run();
        tx.insert(schema.settings).values({ key: "bootstrap_admin_done", value: { userId: u.id, at: t }, updatedAt: t }).run();
        audit(this.db, { actorId: u.id, action: "admin.bootstrap", targetType: "user", targetId: u.id, ip: ctx.ip });
        u = { ...u, role: "admin" };
        policyChanged = true;
      }
      tx.update(schema.users).set({ name: name || u.name, email, lastLoginAt: t, updatedAt: t }).where(eq(schema.users.id, u.id)).run();
      // Group sync: memberships follow the provider's group claim on every sign-in.
      const gc = groupsClaim(c);
      if (gc && recordProviderGroups(this.db, u.id, claimValues(claims, gc), { ip: ctx.ip })) policyChanged = true;
      return u;
    }, { behavior: "immediate" });
    // Only a new profile, the bootstrap promotion or a group-sync change alters what Policy caches.
    if (policyChanged) this.policy.invalidate();
    if (user.status !== "active") fail("user_disabled", { userId: user.id });

    const previous = ctx.previousSessionToken ? this.sessions.load(ctx.previousSessionToken, false) : undefined;
    const { token, session } = this.sessions.create(user.id, { providerSid: typeof claims.sid === "string" ? claims.sid : undefined, idToken: tokens.id_token, refreshToken: tokens.refresh_token, userAgent: ctx.userAgent, ip: ctx.ip, replaces: previous?.id });
    audit(this.db, { actorId: user.id, action: "auth.login", targetType: "session", targetId: session.id, ip: ctx.ip });
    return { token, session, user, returnTo: safeReturnTo(txn!.returnTo) };
  }

  /** Ends the Unifeye session immediately and returns the provider's end-session URL for the browser. */
  async logout(session: SessionRow): Promise<string> {
    const c = config();
    let hint: string | undefined;
    try { if (session.idTokenEnc && c.TOKEN_ENC_KEY) hint = decrypt(session.idTokenEnc, c.TOKEN_ENC_KEY); } catch { /* fall through without a hint */ }
    this.sessions.revoke(session.id, "logout");
    audit(this.db, { actorId: session.userId, action: "auth.logout", targetType: "session", targetId: session.id });
    try {
      const cfg = await this.configuration();
      if (!cfg.serverMetadata().end_session_endpoint) return this.postLogoutUri();
      return oidc.buildEndSessionUrl(cfg, { post_logout_redirect_uri: this.postLogoutUri(), client_id: c.OIDC_CLIENT_ID!, ...(hint ? { id_token_hint: hint } : {}) }).toString();
    } catch {
      return this.postLogoutUri(); // provider unreachable: the local session is already gone
    }
  }

  /**
   * OIDC Back-Channel Logout 1.0. The logout token is verified like an ID token (signature via the
   * issuer's JWKS, iss, aud, iat/exp) and must carry the back-channel event, a `sid` or `sub`,
   * a fresh `jti`, and no `nonce`. Matching sessions are revoked, which also stops their media.
   */
  async backchannelLogout(logoutToken: string): Promise<number> {
    const c = config(), cfg = await this.configuration(), meta = cfg.serverMetadata();
    let p: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      p = (await jwtVerify(logoutToken, this.keys(cfg), { issuer: meta.issuer, audience: c.OIDC_CLIENT_ID!, maxTokenAge: "10m", clockTolerance: 30 })).payload;
    } catch (e) {
      audit(this.db, { action: "auth.backchannel_logout", outcome: "denied", detail: { reason: (e as Error).message } });
      throw new HttpError(400, "invalid_request");
    }
    const events = p.events as Record<string, unknown> | undefined;
    const sid = typeof p.sid === "string" ? p.sid : undefined, sub = typeof p.sub === "string" ? p.sub : undefined;
    const bad = !events || typeof events !== "object" || !(LOGOUT_EVENT in events) || "nonce" in p || (!sid && !sub) || typeof p.jti !== "string" || typeof p.iat !== "number";
    if (bad) {
      audit(this.db, { action: "auth.backchannel_logout", outcome: "denied", detail: { reason: "malformed_logout_token" } });
      throw new HttpError(400, "invalid_request");
    }
    const t = Date.now();
    this.db.delete(schema.logoutTokenJtis).where(lt(schema.logoutTokenJtis.expiresAt, t)).run();
    try {
      this.db.insert(schema.logoutTokenJtis).values({ jti: p.jti as string, expiresAt: t + 24 * 36e5 }).run();
    } catch {
      audit(this.db, { action: "auth.backchannel_logout", outcome: "denied", detail: { reason: "replayed_jti" } });
      throw new HttpError(400, "invalid_request");
    }
    let n = 0;
    if (sid) n = this.sessions.revokeBySid(sid, "provider_logout");
    else {
      const u = this.db.select().from(schema.users).where(and(eq(schema.users.issuer, meta.issuer), eq(schema.users.subject, sub!))).get();
      if (u) n = this.sessions.revokeUser(u.id, "provider_logout");
    }
    audit(this.db, { action: "auth.backchannel_logout", detail: { sessions: n, by: sid ? "sid" : "sub" } });
    return n;
  }

  /**
   * Group sync during re-validation, so a group removed at the provider takes effect within
   * OIDC_RECHECK_SECONDS rather than at the next sign-in. Only an ID token that verifies against the
   * issuer's keys and names this exact person is used; anything else leaves memberships unchanged.
   */
  private async resyncGroups(cfg: oidc.Configuration, userId: string, idToken: string) {
    const c = config(), gc = groupsClaim(c);
    if (!gc) return;
    const u = this.db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
    if (!u) return;
    try {
      const { payload } = await jwtVerify(idToken, this.keys(cfg), { issuer: cfg.serverMetadata().issuer, audience: c.OIDC_CLIENT_ID!, subject: u.subject, clockTolerance: 30 });
      if (payload.iss !== u.issuer) return;
      if (this.db.transaction(() => recordProviderGroups(this.db, u.id, claimValues(payload, gc)), { behavior: "immediate" })) this.policy.invalidate();
    } catch (e) {
      log("warn", "group sync skipped: the refreshed ID token did not verify", { userId, error: e });
    }
  }

  /**
   * Lifecycle reconciliation. Back-channel logout covers session termination and sign-out, but
   * providers generally do not send it when a user is deactivated, locked or deleted. Each session
   * therefore holds a refresh token (encrypted, used for nothing else) that is exercised on a schedule:
   *  - provider rejects it  -> the session is revoked (detected within OIDC_RECHECK_SECONDS).
   *  - provider unreachable -> nothing is extended; after OIDC_MAX_STALE_SECONDS the session is suspended.
   * A session that received no refresh token is not re-checked; it ends on back-channel logout or its own limits.
   * When the refresh response carries an ID token, group memberships are re-synced from it as well.
   */
  async reconcile(): Promise<{ checked: number; revoked: number; unreachable: number }> {
    const c = config(), out = { checked: 0, revoked: 0, unreachable: 0 };
    if (!c.TOKEN_ENC_KEY) return out;
    const due = this.sessions.dueForValidation(c.OIDC_RECHECK_SECONDS * 1000);
    if (!due.length) return out;
    let cfg: oidc.Configuration;
    try { cfg = await this.configuration(); } catch { out.unreachable = due.length; return out; }
    for (const s of due) {
      out.checked++;
      try {
        const r = await oidc.refreshTokenGrant(cfg, decrypt(s.refreshTokenEnc!, c.TOKEN_ENC_KEY));
        this.sessions.markValidated(s.id, r.refresh_token);
        if (r.id_token) await this.resyncGroups(cfg, s.userId, r.id_token);
      } catch (e) {
        if (e instanceof oidc.ResponseBodyError && e.status >= 400 && e.status < 500) {
          this.sessions.revoke(s.id, "provider_revoked");
          audit(this.db, { actorId: s.userId, action: "auth.provider_revoked", targetType: "session", targetId: s.id, detail: { error: e.error } });
          out.revoked++;
        } else {
          out.unreachable++;
          log("warn", "session re-validation could not reach the identity provider", { sessionId: s.id, error: e });
        }
      }
    }
    return out;
  }
}
