import { and, eq, isNull, lt, lte, or, type SQL } from "drizzle-orm";
import { config, sessionIdleMs, sessionLifetimeMs } from "../config";
import { schema, type Db } from "../db";
import type { Policy } from "../authz/policy";
import { encrypt, hashToken, newId, randomToken } from "../util";

export type SessionRow = typeof schema.sessions.$inferSelect;
export const SESSION_COOKIE = "unifeye_session";

/**
 * Server-managed sessions for every sign-in method. The cookie holds an opaque random token; only its
 * SHA-256 is stored. A session is usable only while: not revoked, inside its idle and absolute
 * lifetimes, its user is active (which includes their sign-in method being on), and it was
 * re-validated recently enough: with the identity provider for `oidc` sessions that hold a refresh
 * token, or by a request carrying a valid Cloudflare Access token for `cloudflare` sessions.
 */
export class Sessions {
  private ended = new Set<() => void>();
  constructor(private db: Db, private policy: Policy) {}

  /** Called after one or more sessions stop being usable for good (revoked, rotated, expired). */
  onEnd(fn: () => void) {
    this.ended.add(fn);
    return () => { this.ended.delete(fn); };
  }
  private notifyEnded() {
    for (const fn of [...this.ended]) fn();
  }
  /** The one statement of when a session row is usable. `suspended` can recover; the others cannot. */
  private state(s: SessionRow | undefined, t = Date.now()): "live" | "gone" | "expired" | "user_inactive" | "suspended" {
    if (!s || s.revokedAt) return "gone";
    if (t >= s.idleExpiresAt || t >= s.absoluteExpiresAt) return "expired";
    const u = this.policy.activeUser(s.userId);
    if (!u) return "user_inactive";
    // Provider re-validation overdue (provider unreachable for too long): suspend, do not extend.
    if (s.refreshTokenEnc && t - s.lastValidatedAt > config().OIDC_MAX_STALE_SECONDS * 1000) return "suspended";
    // Cloudflare: no request with a valid Access token for too long, so Cloudflare may have stopped
    // letting this person through. Suspend; the next request through Cloudflare signs in again.
    if (u.authMethod === "cloudflare" && t - s.lastValidatedAt > config().CF_ACCESS_RECHECK_SECONDS * 1000) return "suspended";
    return "live";
  }

  create(userId: string, o: { providerSid?: string; idToken?: string; refreshToken?: string; userAgent?: string; ip?: string; replaces?: string }) {
    const c = config(), t = Date.now(), token = randomToken();
    const absoluteExpiresAt = t + sessionLifetimeMs(c), idle = sessionIdleMs(c);
    const enc = (v?: string) => (v && c.TOKEN_ENC_KEY ? encrypt(v, c.TOKEN_ENC_KEY) : null);
    const row: SessionRow = {
      id: newId(), tokenHash: hashToken(token), userId, providerSid: o.providerSid ?? null,
      idTokenEnc: enc(o.idToken), refreshTokenEnc: enc(o.refreshToken), csrfSecret: randomToken(),
      createdAt: t, lastSeenAt: t, idleExpiresAt: idle ? Math.min(t + idle, absoluteExpiresAt) : absoluteExpiresAt, absoluteExpiresAt,
      lastValidatedAt: t, revokedAt: null, revokeReason: null, userAgent: o.userAgent?.slice(0, 300) ?? null, ip: o.ip ?? null,
    };
    const rotated = this.db.transaction((tx) => {
      // Rotation: a successful sign-in never reuses a previous session identifier.
      const n = o.replaces ? tx.update(schema.sessions).set({ revokedAt: t, revokeReason: "rotated" }).where(and(eq(schema.sessions.id, o.replaces), isNull(schema.sessions.revokedAt))).run().changes : 0;
      tx.insert(schema.sessions).values(row).run();
      return n;
    });
    if (rotated) this.notifyEnded(); // anything still held under the replaced session stops
    return { token, session: row };
  }

  /** Returns the live session for a cookie value, or undefined. Fails closed on every doubt. */
  load(token: string | undefined, touch = true): SessionRow | undefined {
    if (!token) return;
    const s = this.db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token))).get();
    const t = Date.now(), state = this.state(s, t);
    if (!s || state === "gone" || state === "suspended") return;
    if (state !== "live") return void this.revoke(s.id, state);
    if (touch) this.touch(s, t);
    return s;
  }
  /** Extends the idle limit after the session has been accepted for a request. */
  touch(s: SessionRow, t = Date.now()) {
    if (t - s.lastSeenAt <= 60_000) return;
    const ms = sessionIdleMs();
    const idle = ms ? Math.min(t + ms, s.absoluteExpiresAt) : s.absoluteExpiresAt;
    this.db.update(schema.sessions).set({ lastSeenAt: t, idleExpiresAt: idle }).where(eq(schema.sessions.id, s.id)).run();
  }

  byId(id: string) {
    return this.db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  }
  /** True while the session id is still usable. Read-only: it never revokes or notifies. */
  isLive(id: string): boolean {
    return this.state(this.byId(id)) === "live";
  }
  /** Background sweep: record idle and absolute timeouts even if no request arrives to notice them. */
  expireDue() {
    const t = Date.now();
    return this.end(or(lte(schema.sessions.idleExpiresAt, t), lte(schema.sessions.absoluteExpiresAt, t))!, "expired");
  }

  private end(where: SQL, reason: string): number {
    const n = this.db.update(schema.sessions).set({ revokedAt: Date.now(), revokeReason: reason, refreshTokenEnc: null, idTokenEnc: null }).where(and(where, isNull(schema.sessions.revokedAt))).run().changes;
    if (n) this.notifyEnded();
    return n;
  }
  revokeWhere(where: SQL, reason: string) { return this.end(where, reason); }
  revoke(id: string, reason: string) { return this.end(eq(schema.sessions.id, id), reason); }
  revokeUser(userId: string, reason: string) { return this.end(eq(schema.sessions.userId, userId), reason); }
  revokeBySid(sid: string, reason: string) { return this.end(eq(schema.sessions.providerSid, sid), reason); }
  revokeAll(reason: string) { return this.end(eq(schema.sessions.id, schema.sessions.id), reason); }

  /** Revokes the session a cookie names, whatever its state. Used when a sign-in replaces it. */
  revokeToken(token: string | undefined, reason: string) {
    return token ? this.end(eq(schema.sessions.tokenHash, hashToken(token)), reason) : 0;
  }
  markValidated(id: string, refreshToken?: string) {
    const c = config();
    this.db.update(schema.sessions).set({ lastValidatedAt: Date.now(), ...(refreshToken && c.TOKEN_ENC_KEY ? { refreshTokenEnc: encrypt(refreshToken, c.TOKEN_ENC_KEY) } : {}) }).where(eq(schema.sessions.id, id)).run();
  }
  /** Sessions due for provider re-validation. */
  dueForValidation(olderThanMs: number) {
    return this.db.select().from(schema.sessions).where(and(isNull(schema.sessions.revokedAt), lt(schema.sessions.lastValidatedAt, Date.now() - olderThanMs))).all().filter((s) => s.refreshTokenEnc);
  }
  purgeExpired() {
    const cutoff = Date.now() - 7 * 864e5;
    return this.db.delete(schema.sessions).where(lt(schema.sessions.absoluteExpiresAt, cutoff)).run().changes;
  }
}
