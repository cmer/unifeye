import { createRemoteJWKSet, jwtVerify } from "jose";
import { audit } from "../audit";
import type { Policy, UserRow } from "../authz/policy";
import { cloudflareIssuer, config, signInMethods } from "../config";
import type { Db } from "../db";
import { log, safeEqual } from "../util";
import { AdmissionError } from "./oidc";
import { provisionExternal } from "./provision";
import type { SessionRow, Sessions } from "./session";

/** The header Cloudflare Access adds to every request it lets through to the origin. */
export const CF_ASSERTION_HEADER = "cf-access-jwt-assertion";
/** Set by a Cloudflare Transform Rule to CF_ACCESS_ORIGIN_SECRET, proving the request passed through Cloudflare. */
export const CF_ORIGIN_SECRET_HEADER = "x-unifeye-origin-secret";
export type Channel = { via: "cloudflare"; assertion: string } | { via: "direct" } | { via: "forged" };
export interface CloudflareIdentity { issuer: string; subject: string; email: string | null; name: string }

/**
 * Cloudflare Access (SIGN_IN_METHODS `cloudflare`). Access sits in front of Unifeye, signs the person
 * in, and adds a signed token (`Cf-Access-Jwt-Assertion`) to every request it forwards.
 *
 *  - The token is verified on every request: RS256 signature against the team's published keys,
 *    issuer = the team domain, audience = one of CF_ACCESS_AUD, not expired, and a subject present
 *    (service tokens, which have none, are refused). The cookie Access also sets is never used.
 *  - On the first request a normal Unifeye session is created for the exact (issuer, subject) pair.
 *    Later requests must carry a token for that same identity, or the session is not accepted.
 *  - A valid token does not by itself prove the request came through Cloudflare: whoever holds one
 *    can attach it to a request sent straight to the server. With CF_ACCESS_ORIGIN_SECRET set (required
 *    alongside passwords), a request carrying the token must also carry the secret header Cloudflare
 *    adds at its edge; one without it is treated as forged and refused, never as local.
 *  - Requests without the header did not come through Cloudflare. They are never accepted for a
 *    Cloudflare identity; with passwords on, they may use a password account (local network access).
 *  - Each valid request refreshes the session's validation time. A session not seen through
 *    Cloudflare for CF_ACCESS_RECHECK_SECONDS is suspended, which also stops its video.
 */
export class CloudflareAccess {
  private jwks?: { team: string; set: ReturnType<typeof createRemoteJWKSet> };
  constructor(private db: Db, private policy: Policy, private sessions: Sessions) {}

  private keys(team: string) {
    if (this.jwks?.team !== team) this.jwks = { team, set: createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`), { timeoutDuration: 5000, cooldownDuration: 30_000 }) };
    return this.jwks.set;
  }

  /**
   * Which way the request arrived.
   *  - `direct`: no sign of Cloudflare at all (neither an Access token nor the origin secret header).
   *  - `forged`: it carries an Access token (even an empty one) without the right origin secret, or
   *    any origin secret header without an Access token. The second means Cloudflare forwarded a
   *    request Access did not cover (a Bypass rule, an uncovered path); that must not reach password
   *    sign-in from the internet, so it fails closed.
   *  - `cloudflare`: an Access token, plus the right secret when one is configured.
   */
  channel(req: Request): Channel {
    const c = config();
    const token = req.headers.has(CF_ASSERTION_HEADER), edge = req.headers.has(CF_ORIGIN_SECRET_HEADER);
    if (!signInMethods(c).cloudflare || (!token && !edge)) return { via: "direct" };
    if (c.CF_ACCESS_ORIGIN_SECRET) {
      if (!safeEqual(req.headers.get(CF_ORIGIN_SECRET_HEADER) ?? "", c.CF_ACCESS_ORIGIN_SECRET) || !token) return { via: "forged" };
    } else if (!token) return { via: "direct" };
    return { via: "cloudflare", assertion: req.headers.get(CF_ASSERTION_HEADER) ?? "" };
  }

  /** The identity in a request's Access token, or null when it is missing or does not verify. */
  async verify(assertion: string | null | undefined): Promise<CloudflareIdentity | null> {
    const c = config(), iss = cloudflareIssuer(c);
    if (!signInMethods(c).cloudflare || !iss || !c.CF_ACCESS_TEAM_DOMAIN || !assertion || assertion.length > 16_384) return null;
    try {
      const { payload: p } = await jwtVerify(assertion, this.keys(c.CF_ACCESS_TEAM_DOMAIN), { issuer: iss, audience: c.CF_ACCESS_AUD, algorithms: ["RS256"], clockTolerance: 30, requiredClaims: ["sub", "exp", "iat"] });
      if (typeof p.sub !== "string" || !p.sub) return null;
      return { issuer: iss, subject: p.sub, email: typeof p.email === "string" ? p.email : null, name: typeof p.name === "string" ? p.name.slice(0, 200) : "" };
    } catch (e) {
      log("warn", "Cloudflare Access token refused", { error: e });
      return null;
    }
  }

  /** True when the session belongs to exactly this Cloudflare identity. Refreshes its validation time. */
  accept(session: SessionRow, user: UserRow, id: CloudflareIdentity): boolean {
    if (user.authMethod !== "cloudflare" || user.issuer !== id.issuer || user.subject !== id.subject) return false;
    if (Date.now() - session.lastValidatedAt > 30_000) this.sessions.markValidated(session.id);
    return true;
  }

  /** Creates a session for the person Cloudflare vouches for, replacing whatever session the browser had. */
  async signIn(assertion: string | null | undefined, ctx: { ip?: string; userAgent?: string; previousSessionToken?: string }) {
    const fail = (reason: string, detail?: Record<string, unknown>): never => {
      audit(this.db, { action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { method: "cloudflare", reason, ...detail } });
      throw new AdmissionError(reason);
    };
    const id = await this.verify(assertion);
    if (!id) return fail("token_validation_failed");
    let r: ReturnType<typeof provisionExternal>;
    try {
      r = this.db.transaction((tx) => provisionExternal(tx, this.db, { method: "cloudflare", ...id }, ctx.ip), { behavior: "immediate" });
    } catch (e) {
      if ((e as { reason?: unknown }).reason === "method_mismatch") return fail("method_mismatch", { sub: id.subject });
      throw e;
    }
    if (r.changed) this.policy.invalidate();
    if (!this.policy.activeUser(r.user.id)) return fail("user_disabled", { userId: r.user.id });
    this.sessions.revokeToken(ctx.previousSessionToken, "rotated");
    const { token, session } = this.sessions.create(r.user.id, { userAgent: ctx.userAgent, ip: ctx.ip });
    audit(this.db, { actorId: r.user.id, action: "auth.login", targetType: "session", targetId: session.id, ip: ctx.ip, detail: { method: "cloudflare" } });
    return { token, session, user: r.user };
  }
}
