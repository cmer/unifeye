import { and, eq, gt, isNull, lt, ne, type SQL } from "drizzle-orm";
import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { z } from "zod";
import { audit } from "../audit";
import type { Policy } from "../authz/policy";
import { config, emailCodesOn, signInMethods, ssoDomain } from "../config";
import { schema, type Db } from "../db";
import type { Mailer } from "../mail";
import { badRequest, hashToken, HttpError, newId, randomToken, safeEqual } from "../util";
import type { Sessions } from "./session";

/**
 * Password accounts (SIGN_IN_METHODS `local`).
 *
 *  - Only administrators (or the operator, from the command line) create them. There is no sign-up.
 *  - Nobody but the person ever knows the password: an account starts with no password and a
 *    one-time link (24 hours, stored hashed) lets the person choose one. A forgotten password is
 *    handled the same way: an administrator makes a new link.
 *  - Identity is the profile's own (issuer = LOCAL_ISSUER, subject = random id) pair; the username is
 *    only the sign-in key. Nothing links a password account to an `oidc` or `cloudflare` one.
 *  - Passwords are hashed with scrypt (N=2^15, r=8, p=3, one of OWASP's equivalent settings at 32 MB).
 *    Wrong usernames and wrong passwords take the same time and give the same answer, and repeated
 *    failures lock the username for a while whether or not it exists, so the answers never reveal
 *    which usernames are real. Checks run at most MAX_VERIFYING at a time (libuv has four worker
 *    threads, shared with file I/O), up to MAX_WAITING more wait their turn, and beyond that a
 *    sign-in is refused with "try again in a moment" before it is counted.
 *  - Email codes (when outgoing mail is set up): an administrator can give an account addresses that
 *    sign-in codes go to, instead of or as well as a password. Someone types the username, a 6-digit
 *    code goes to those addresses, and the code works only in the browser that asked, for 10 minutes
 *    and 5 tries. The addresses can belong to someone else (a manager who says yes for a shared
 *    account). They are delivery addresses only: nobody signs in by typing an email address.
 */
export const LOCAL_ISSUER = "unifeye:local";
export const LINK_TTL_MS = 24 * 36e5;
const SCRYPT = { N: 2 ** 15, r: 8, p: 3, keylen: 32 } as const;
const MAXMEM = 128 * 2 ** 20;
const MAX_FAILS = 5, LOCK_BASE_MS = 30_000, LOCK_MAX_MS = 15 * 60_000;
/** Failures older than this, with no lock running, are forgotten. */
const FORGET_MS = 30 * 60_000;
/** Usernames tracked at once. Only idle, unlocked entries are ever evicted, oldest first. */
const MAX_TRACKED = 100_000;
const MAX_VERIFYING = 2, MAX_WAITING = 20;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_COOKIE = "unifeye_email_code";
const MAX_CODE_TRIES = 5, RESEND_MS = 60_000, SENDS_PER_HOUR = 5;
export const MAX_CODE_EMAILS = 3;

const scrypt = (pw: string, salt: Buffer, keylen: number, o: ScryptOptions) => new Promise<Buffer>((res, rej) => scryptCb(pw, salt, keylen, o, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16), { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(pw.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: MAXMEM });
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  const N = Number(n), R = Number(r), P = Number(p);
  // Parameters come from our own rows, but are bounded anyway so a bad row cannot pin the CPU.
  if (alg !== "scrypt" || !salt || !hash || !(N >= 2 ** 14 && N <= 2 ** 17) || !(R >= 8 && R <= 16) || !(P >= 1 && P <= 4)) return false;
  const want = Buffer.from(hash, "base64url");
  if (want.length < 16 || want.length > 64) return false;
  const got = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N, r: R, p: P, maxmem: MAXMEM });
  return timingSafeEqual(got, want);
}
let dummy: Promise<string> | undefined;
/** Verified against when there is no real hash, so an unknown username costs the same time. */
const dummyHash = () => (dummy ??= hashPassword(randomToken()));

export const usernameSchema = z
  .string()
  .transform((v) => v.normalize("NFKC").trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9._@-]{1,63}$/, "Usernames use 2 to 64 letters, numbers, dots, dashes, underscores or @."));

const COMMON = new Set(["password", "password1", "password12", "password123", "passw0rd123", "1234567890", "12345678910", "0123456789", "qwertyuiop", "qwerty1234", "1q2w3e4r5t", "iloveyou12", "letmein123", "welcome123", "admin12345", "administrator", "changeme123", "unifeye123", "abcdefghij", "aaaaaaaaaa", "1111111111", "0000000000"]);
/** A short reason the password can't be used, or null. Length matters most; no composition rules. */
export function passwordProblem(pw: unknown, username: string): string | null {
  if (typeof pw !== "string" || [...pw].length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "Use 200 characters or fewer.";
  const l = pw.normalize("NFKC").toLowerCase();
  if (COMMON.has(l) || /^(.)\1+$/.test(l)) return "That password is too easy to guess. Try a short phrase.";
  if (username.length >= 3 && l.includes(username)) return "Don't include your username in your password.";
  return null;
}

/** Where sign-in codes go: up to three addresses, stored lowercase, no duplicates. */
export const codeEmailsSchema = z
  .array(z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address.")))
  .max(MAX_CODE_EMAILS, `Codes can go to up to ${MAX_CODE_EMAILS} addresses.`)
  .transform((v) => [...new Set(v)]);

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Inserts a password account with no password yet. Caller validates, audits and invalidates. */
export function insertLocalUser(tx: Tx, o: { name: string; username: string; role: "admin" | "staff"; passwordAllowed?: boolean; codeEmails?: string[] }) {
  const t = Date.now(), id = newId(), sso = ssoDomain(o.username);
  if (sso) throw badRequest(`People at ${sso} sign in with ${config().OIDC_DISPLAY_NAME}. Choose a different username.`);
  if (tx.select().from(schema.localCredentials).where(eq(schema.localCredentials.username, o.username)).get()) throw new HttpError(409, "conflict", "That username is taken.");
  tx.insert(schema.users).values({ id, issuer: LOCAL_ISSUER, subject: id, name: o.name, email: null, role: o.role, authMethod: "local", status: "active", createdAt: t, updatedAt: t }).run();
  tx.insert(schema.localCredentials).values({ userId: id, username: o.username, passwordHash: null, passwordSetAt: null, passwordAllowed: o.passwordAllowed ?? true, codeEmails: o.codeEmails ?? [], createdAt: t }).run();
  return id;
}
/** Where password links point: the local address when there is one, since that is where these people sign in. */
export const linkUrl = (token: string) => new URL(`/set-password#${token}`, config().LOCAL_APP_URL ?? config().APP_URL).toString();
/** A new one-time password link for a password account. Any earlier unused link stops working. */
export function issuePasswordLink(db: Db | Tx, userId: string, createdBy: string | null) {
  const token = randomToken(), t = Date.now(), expiresAt = t + LINK_TTL_MS;
  db.delete(schema.passwordLinks).where(eq(schema.passwordLinks.userId, userId)).run();
  db.insert(schema.passwordLinks).values({ id: hashToken(token), userId, createdBy, createdAt: t, expiresAt }).run();
  return { url: linkUrl(token), expiresAt };
}

const wrong = () => new HttpError(401, "wrong_password", "That username and password don't match. Try again.");
const locked = () => new HttpError(429, "too_many_tries", "Too many tries. Wait a few minutes and try again.");
const busy = () => new HttpError(429, "busy", "Lots of sign-ins right now. Try again in a moment.");
const linkGone = () => new HttpError(404, "link_expired", "This link has expired. Ask an administrator for a new one.");
const accountOff = () => new HttpError(403, "account_off", "This account is turned off. Ask an administrator.");
const wrongCode = () => new HttpError(400, "wrong_code", "That code isn't right. Try again.");
const codeGone = () => new HttpError(400, "code_expired", "This code has expired. Send a new one.");
const codeTries = () => new HttpError(400, "too_many_tries", "Too many tries. Send a new code.");
/** The username is at a domain in OIDC_EMAIL_DOMAINS. Depends only on configuration, so it reveals nothing about accounts. */
const ssoOnly = () => new HttpError(403, "use_sso", `Sign in with ${config().OIDC_DISPLAY_NAME} instead.`);

/** "Chrome on Windows", from a User-Agent, for the sign-in email. Rough on purpose. */
export function describeDevice(ua = ""): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /(Chrome|CriOS)\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : null;
  return browser && os ? `${browser} on ${os}` : browser ?? os ?? "A web browser";
}
/** The time of the request, in the asking browser's time zone when it sent a valid one. */
function describeTime(at: number, timeZone?: string) {
  const fmt = (tz?: string) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: tz, timeZoneName: tz ? undefined : "short" }).format(at);
  try { return fmt(typeof timeZone === "string" && timeZone.length <= 64 ? timeZone : undefined); } catch { return fmt(); }
}
export function codeEmail(o: { name: string; code: string; device: string; when: string }) {
  const code = `${o.code.slice(0, 3)} ${o.code.slice(3)}`;
  return {
    // The code stays out of the subject: phones show subjects on the lock screen.
    subject: `Sign-in code for ${o.name}`,
    text: [
      `Someone is signing in to Unifeye as ${o.name}.`, "",
      `        ${code}`, "",
      `${o.device} · ${o.when}`, "",
      "Only share this code with someone you expect.",
      "It works for 10 minutes.", "",
      "Not expecting this? You can ignore this email.",
      "No one can sign in without the code.", "",
    ].join("\n"),
  };
}

interface Ctx { ip?: string; userAgent?: string; previousSessionToken?: string }

export class LocalAccounts {
  /**
   * Failed attempts per username (existing or not), in memory; a restart forgets them. Kept in order
   * of last attempt (re-inserted on each one), so eviction can take the oldest idle entries first.
   */
  private fails = new Map<string, { n: number; until: number; last: number }>();
  private verifying = 0;
  private waiting: (() => void)[] = [];
  /** When codes were sent per username (existing or not) in the last hour. In memory. */
  private sends = new Map<string, number[]>();
  constructor(private db: Db, private policy: Policy, private sessions: Sessions, private mailer: Mailer) {}

  private enabled() {
    if (!signInMethods().local) throw new HttpError(404, "not_found", "This is no longer available.");
  }
  private codesEnabled() {
    if (!emailCodesOn()) throw new HttpError(404, "not_found", "This is no longer available.");
  }
  /**
   * Counts an attempt before the slow check, so parallel guesses cannot all slip past the limit.
   * Five in a row lock the key for 30 seconds, doubling up to 15 minutes. A key left alone for
   * FORGET_MS starts again from zero.
   */
  private attempt(key: string, ip?: string, userId?: string) {
    const t = Date.now();
    let f = this.fails.get(key);
    if (f && f.until > t) throw locked();
    if (!f || t - f.last > FORGET_MS) f = { n: 0, until: 0, last: t };
    f.n++;
    f.last = t;
    if (f.n >= MAX_FAILS) {
      f.until = t + Math.min(LOCK_BASE_MS * 2 ** (f.n - MAX_FAILS), LOCK_MAX_MS);
      audit(this.db, { actorId: userId, action: "auth.locked", outcome: "denied", ip, detail: { method: "local", known: !!userId } });
    }
    this.fails.delete(key);
    this.fails.set(key, f); // move to the end: the map stays ordered by last attempt
    if (this.fails.size > MAX_TRACKED)
      for (const [k, v] of this.fails) {
        if (this.fails.size <= MAX_TRACKED * 0.9 || k === key) break;
        if (v.until <= t) this.fails.delete(k); // never a running lock
      }
  }
  /** True when no more checks can be accepted. Called before counting an attempt. */
  private full() {
    return this.verifying + this.waiting.length >= MAX_VERIFYING + MAX_WAITING;
  }
  /** Runs one password check, waiting in line (first come, first served) when the slots are taken. */
  private async check(pw: string, hash: string) {
    if (this.full()) throw busy();
    if (this.verifying >= MAX_VERIFYING) await new Promise<void>((go) => this.waiting.push(go));
    else this.verifying++;
    try { return await verifyPassword(pw, hash); } finally {
      const next = this.waiting.shift();
      if (next) next(); else this.verifying--; // hand the slot straight to the next in line
    }
  }
  private cred(where: SQL) {
    return this.db.select({ userId: schema.localCredentials.userId, username: schema.localCredentials.username, passwordHash: schema.localCredentials.passwordHash, passwordAllowed: schema.localCredentials.passwordAllowed, codeEmails: schema.localCredentials.codeEmails, name: schema.users.name })
      .from(schema.localCredentials).innerJoin(schema.users, eq(schema.users.id, schema.localCredentials.userId)).where(where).get();
  }
  private startSession(userId: string, ctx: Ctx, via: "password" | "email" = "password") {
    // A sign-in always gets a new session; whatever session this browser held before ends.
    this.sessions.revokeToken(ctx.previousSessionToken, "rotated");
    const r = this.sessions.create(userId, { userAgent: ctx.userAgent, ip: ctx.ip });
    this.db.update(schema.users).set({ lastLoginAt: Date.now() }).where(eq(schema.users.id, userId)).run();
    audit(this.db, { actorId: userId, action: "auth.login", targetType: "session", targetId: r.session.id, ip: ctx.ip, detail: { method: "local", via } });
    return r;
  }

  async signIn(rawUsername: unknown, password: unknown, ctx: Ctx) {
    this.enabled();
    if (ssoDomain(rawUsername)) throw ssoOnly();
    const parsed = usernameSchema.safeParse(typeof rawUsername === "string" ? rawUsername : "");
    const key = parsed.success ? parsed.data : `invalid:${String(rawUsername).slice(0, 64)}`;
    const c = parsed.success ? this.cred(eq(schema.localCredentials.username, parsed.data)) : undefined;
    const pw = typeof password === "string" && password.length <= 200 ? password : "";
    const real = c?.passwordAllowed ? c.passwordHash : null; // an account without password sign-in has none
    const hash = real ?? (await dummyHash());
    if (this.full()) throw busy(); // before counting, so a refusal costs no attempt
    this.attempt(key, ctx.ip, c?.userId);
    const ok = await this.check(pw, hash);
    if (!c || !real || !ok) {
      audit(this.db, { actorId: c?.userId, action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { method: "local", reason: c ? "wrong_password" : "unknown_username" } });
      throw wrong();
    }
    this.fails.delete(key);
    if (!this.policy.activeUser(c.userId)) {
      audit(this.db, { actorId: c.userId, action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { method: "local", reason: "user_disabled" } });
      throw accountOff();
    }
    return this.startSession(c.userId, ctx);
  }

  /** Who a password link is for, so the page can say so. Reveals nothing for a bad or used link. */
  inspectLink(token: unknown) {
    this.enabled();
    const l = this.liveLink(token);
    const c = l && this.cred(eq(schema.localCredentials.userId, l.userId));
    if (!l || !c || !c.passwordAllowed || !this.policy.activeUser(c.userId)) throw linkGone();
    if (ssoDomain(c.username)) throw ssoOnly();
    return { username: c.username, name: c.name, firstTime: !c.passwordHash };
  }
  private liveLink(token: unknown) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return undefined;
    return this.db.select().from(schema.passwordLinks).where(and(eq(schema.passwordLinks.id, hashToken(token)), isNull(schema.passwordLinks.usedAt), gt(schema.passwordLinks.expiresAt, Date.now()))).get();
  }

  /** Sets the password from a one-time link, ends every other session of the person and signs them in. */
  async useLink(token: unknown, password: unknown, ctx: Ctx) {
    let info: ReturnType<LocalAccounts["inspectLink"]>;
    try { info = this.inspectLink(token); } catch (e) {
      if ((e as { code?: unknown }).code === "link_expired") audit(this.db, { action: "auth.password_set", outcome: "denied", ip: ctx.ip, detail: { via: "link", reason: "link_expired" } });
      throw e;
    }
    const problem = passwordProblem(password, info.username);
    if (problem) throw badRequest(problem);
    const hash = await hashPassword(password as string);
    const id = hashToken(token as string), t = Date.now();
    const userId = this.db.transaction((tx) => {
      const l = tx.select().from(schema.passwordLinks).where(eq(schema.passwordLinks.id, id)).get();
      // Consumed inside the write transaction, so two uses of the same link cannot both succeed.
      if (!l || !tx.update(schema.passwordLinks).set({ usedAt: t }).where(and(eq(schema.passwordLinks.id, id), isNull(schema.passwordLinks.usedAt), gt(schema.passwordLinks.expiresAt, t))).run().changes) throw linkGone();
      tx.update(schema.localCredentials).set({ passwordHash: hash, passwordSetAt: t }).where(eq(schema.localCredentials.userId, l.userId)).run();
      return l.userId;
    }, { behavior: "immediate" });
    this.fails.delete(info.username);
    this.sessions.revokeUser(userId, "password_changed");
    audit(this.db, { actorId: userId, action: "auth.password_set", targetType: "user", targetId: userId, ip: ctx.ip, detail: { via: "link" } });
    if (!this.policy.activeUser(userId)) throw accountOff();
    return this.startSession(userId, ctx);
  }

  /** Whether this person can sign in with a password they've already chosen (and so can change it). */
  hasPassword(userId: string) {
    const c = this.cred(eq(schema.localCredentials.userId, userId));
    return !!c?.passwordAllowed && !!c.passwordHash;
  }

  /** A signed-in password user changes their own password. Every other session of theirs ends. */
  async changePassword(userId: string, sessionId: string, current: unknown, next: unknown, ip?: string) {
    this.enabled();
    const c = this.cred(eq(schema.localCredentials.userId, userId));
    if (!c?.passwordHash || !c.passwordAllowed) throw new HttpError(404, "not_found", "This is no longer available.");
    // Counted separately from sign-in, so mistyping here can't lock the person out of signing in.
    const key = `self:${userId}`;
    if (this.full()) throw busy();
    this.attempt(key, ip, userId);
    if (!(await this.check(typeof current === "string" && current.length <= 200 ? current : "", c.passwordHash))) {
      audit(this.db, { actorId: userId, action: "auth.password_set", outcome: "denied", ip, detail: { via: "self", reason: "wrong_password" } });
      throw new HttpError(400, "wrong_password", "Your current password isn't right.");
    }
    this.fails.delete(key);
    const problem = passwordProblem(next, c.username);
    if (problem) throw badRequest(problem);
    const hash = await hashPassword(next as string);
    this.db.transaction((tx) => {
      tx.update(schema.localCredentials).set({ passwordHash: hash, passwordSetAt: Date.now() }).where(eq(schema.localCredentials.userId, userId)).run();
      tx.delete(schema.passwordLinks).where(eq(schema.passwordLinks.userId, userId)).run(); // an older link must not undo this
    }, { behavior: "immediate" });
    this.sessions.revokeWhere(and(eq(schema.sessions.userId, userId), ne(schema.sessions.id, sessionId))!, "password_changed");
    audit(this.db, { actorId: userId, action: "auth.password_set", targetType: "user", targetId: userId, ip, detail: { via: "self" } });
  }

  // ---- email codes ---------------------------------------------------------
  /**
   * At most one code a minute and five an hour per username, whether or not it exists, so the
   * answers never reveal which usernames are real and nobody can flood someone's inbox.
   */
  private throttle(key: string) {
    const t = Date.now(), recent = (this.sends.get(key) ?? []).filter((x) => t - x < 36e5);
    if (recent.length && t - recent[recent.length - 1] < RESEND_MS) throw new HttpError(429, "code_wait", "Wait a minute before asking for another code.");
    if (recent.length >= SENDS_PER_HOUR) throw new HttpError(429, "too_many_codes", "Too many codes. Try again in an hour.");
    recent.push(t);
    this.sends.delete(key);
    this.sends.set(key, recent);
    if (this.sends.size > MAX_TRACKED)
      for (const [k, v] of this.sends) {
        if (this.sends.size <= MAX_TRACKED * 0.9 || k === key) break;
        if (t - v[v.length - 1] >= 36e5) this.sends.delete(k);
      }
  }

  /**
   * Starts an email sign-in. Always answers the same way: a secret for the asking browser to keep.
   * A code is emailed only when the account exists, is active and has addresses; otherwise the
   * browser gets a request that no code can complete. The email is sent after the answer, so how
   * long it takes reveals nothing either. Asking again replaces the account's earlier code.
   */
  requestCode(rawUsername: unknown, ctx: Ctx & { timeZone?: string }) {
    this.codesEnabled();
    if (ssoDomain(rawUsername)) throw ssoOnly();
    const parsed = usernameSchema.safeParse(typeof rawUsername === "string" ? rawUsername : "");
    const key = parsed.success ? parsed.data : `invalid:${String(rawUsername).slice(0, 64)}`;
    this.throttle(key);
    const c = parsed.success ? this.cred(eq(schema.localCredentials.username, parsed.data)) : undefined;
    const to = c && c.codeEmails.length && this.policy.activeUser(c.userId) ? c : undefined;
    const secret = randomToken(), code = String(randomInt(0, 1_000_000)).padStart(6, "0"), t = Date.now();
    this.db.transaction((tx) => {
      if (to) tx.delete(schema.emailCodes).where(eq(schema.emailCodes.userId, to.userId)).run();
      tx.insert(schema.emailCodes).values({ id: hashToken(secret), userId: to?.userId ?? null, codeHash: hashToken(`${secret}:${code}`), createdAt: t, expiresAt: t + CODE_TTL_MS }).run();
    }, { behavior: "immediate" });
    let sent: Promise<boolean> = Promise.resolve(false);
    if (to) {
      audit(this.db, { actorId: to.userId, action: "auth.code_sent", targetType: "user", targetId: to.userId, ip: ctx.ip, detail: { method: "local", to: to.codeEmails.length } });
      const mail = codeEmail({ name: to.name || to.username, code, device: describeDevice(ctx.userAgent), when: describeTime(t, ctx.timeZone) });
      sent = this.mailer.send({ to: to.codeEmails, ...mail }).then((ok) => {
        if (!ok) audit(this.db, { actorId: to.userId, action: "auth.code_sent", outcome: "error", targetType: "user", targetId: to.userId, ip: ctx.ip, detail: { method: "local", reason: "mail_failed" } });
        return ok;
      });
    }
    return { secret, sent };
  }

  /**
   * Step one of the sign-in page: what to ask for after the username. Only an account that signs in
   * by email code alone goes straight to a code (sent now, unless this browser already holds a live
   * one for it). Everything else, including unknown usernames, gets the same password step, so the
   * answer reveals only that a username is a code-only account. A username at a domain in
   * OIDC_EMAIL_DOMAINS goes to the identity provider, whether or not an account has it.
   */
  start(rawUsername: unknown, heldSecret: string | undefined, ctx: Ctx & { timeZone?: string }): { next: "password" } | { next: "sso" } | { next: "code"; secret?: string } {
    this.enabled();
    if (ssoDomain(rawUsername)) return { next: "sso" };
    const parsed = usernameSchema.safeParse(typeof rawUsername === "string" ? rawUsername : "");
    const c = parsed.success && emailCodesOn() ? this.cred(eq(schema.localCredentials.username, parsed.data)) : undefined;
    if (!c || c.passwordAllowed || !c.codeEmails.length) return { next: "password" };
    if (heldSecret && heldSecret.length <= 100) {
      const held = this.db.select().from(schema.emailCodes).where(and(eq(schema.emailCodes.id, hashToken(heldSecret)), isNull(schema.emailCodes.usedAt), gt(schema.emailCodes.expiresAt, Date.now()))).get();
      if (held?.userId === c.userId && held.tries < MAX_CODE_TRIES) return { next: "code" };
    }
    return { next: "code", secret: this.requestCode(parsed.data, ctx).secret };
  }

  /** Finishes an email sign-in in the browser that asked. Five tries per code, counted before checking. */
  verifyCode(secret: string | undefined, rawCode: unknown, ctx: Ctx) {
    this.codesEnabled();
    if (!secret || secret.length > 100) throw codeGone();
    const id = hashToken(secret), t = Date.now(), live = and(eq(schema.emailCodes.id, id), isNull(schema.emailCodes.usedAt), gt(schema.emailCodes.expiresAt, t));
    const row = this.db.select().from(schema.emailCodes).where(live).get();
    if (!row) throw codeGone();
    if (row.tries >= MAX_CODE_TRIES) throw codeTries();
    this.db.update(schema.emailCodes).set({ tries: row.tries + 1 }).where(eq(schema.emailCodes.id, id)).run();
    const code = (typeof rawCode === "string" ? rawCode : "").replace(/[\s-]/g, "");
    if (!/^\d{6}$/.test(code) || !safeEqual(hashToken(`${secret}:${code}`), row.codeHash) || !row.userId) {
      if (row.userId) audit(this.db, { actorId: row.userId, action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { method: "local", via: "email", reason: "wrong_code" } });
      if (row.tries + 1 >= MAX_CODE_TRIES) {
        if (row.userId) audit(this.db, { actorId: row.userId, action: "auth.code_locked", outcome: "denied", ip: ctx.ip, detail: { method: "local" } });
        throw codeTries();
      }
      throw wrongCode();
    }
    // Used inside the write, so the same code cannot sign in twice.
    if (!this.db.update(schema.emailCodes).set({ usedAt: t }).where(live).run().changes) throw codeGone();
    const userId = row.userId;
    const c = this.cred(eq(schema.localCredentials.userId, userId));
    if (!c || !c.codeEmails.length) throw codeGone(); // email codes were turned off for this account meanwhile
    if (!this.policy.activeUser(userId)) {
      audit(this.db, { actorId: userId, action: "auth.login", outcome: "denied", ip: ctx.ip, detail: { method: "local", via: "email", reason: "user_disabled" } });
      throw accountOff();
    }
    return this.startSession(userId, ctx, "email");
  }

  /** Housekeeping: codes that can no longer be used. */
  purgeCodes() {
    this.db.delete(schema.emailCodes).where(lt(schema.emailCodes.expiresAt, Date.now())).run();
  }
}
