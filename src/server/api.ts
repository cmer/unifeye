import { desc, lt } from "drizzle-orm";
import { ZodError } from "zod";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { audit } from "./audit";
import { versionInfo } from "./version";

import { CODE_COOKIE, CODE_TTL_MS } from "./auth/local";
import { LOGIN_TXN_COOKIE, safeReturnTo } from "./auth/oidc";
import { SESSION_COOKIE, type SessionRow } from "./auth/session";
import { subjectOf, type Actor } from "./authz/actor";
import type { CameraInfo, UserRow } from "./authz/policy";
import { allowedOrigins, config, emailCodesOn, groupsClaim, signInMethods } from "./config";
import { schema } from "./db";
import { backupStatus } from "./db/backup";
import { DIRECT_PROBLEM } from "./media/direct";
import { maxStreams } from "./media/gateway";
import { fileResponse } from "./media/recordings";
import { maybeSeedDemo, services, type Services } from "./services";
import { badRequest, forbidden, HttpError, log, newId, notFound, safeEqual } from "./util";

interface Ctx { req: Request; url: URL; p: Record<string, string>; s: Services; actor: Actor; session: SessionRow; user: UserRow; json: <T = Record<string, unknown>>() => Promise<T>; ip: string; requestId: string }
interface Opts { public?: boolean; admin?: boolean; rate?: "auth" | "media" | "hls" | "write" }
type Handler = (c: Ctx) => Promise<Response | object | void> | Response | object | void;
const routes: { method: string; re: RegExp; keys: string[]; opts: Opts; fn: Handler }[] = [];
function route(method: string, path: string, opts: Opts, fn: Handler) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, opts, fn });
}

// ---- helpers ----------------------------------------------------------------
const secure = () => config().APP_URL.startsWith("https://");
const cookie = (name: string, value: string, maxAgeSec: number, path = "/") => `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure() ? "; Secure" : ""}`;
function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1); }
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const redirect = (to: string, cookies: string[] = []) => { const h = new Headers({ location: to, "cache-control": "no-store" }); cookies.forEach((c) => h.append("set-cookie", c)); return new Response(null, { status: 302, headers: h }); };
const num = (v: string | null, name: string) => { const n = Number(v); if (v == null || v === "" || !Number.isFinite(n)) throw badRequest(`${name} is required`); return n; };
const quality = (v: string | null) => (v === "focus" ? "focus" : "wall") as "focus" | "wall";

/**
 * Requests per minute. Signed-in requests count per session, so people sharing one address (an office,
 * a VPN) do not share a limit; public routes and requests that fail to sign in count per address.
 * `unauth`: requests to signed-in routes without a valid session, such as a wall left open after
 * signing out.
 */
const LIMITS = { auth: 30, media: 600, write: 240, read: 1200, unauth: 600, speedtest: 10 };
type RateClass = keyof typeof LIMITS | "hls";
/**
 * An HLS stream polls a video and a sound playlist and fetches a segment of each every 4 s or so:
 * about 60 requests a minute, more while hls.js re-checks a playlist that has not moved yet. Twice
 * that per stream the session may hold, so a full wall on HLS fits with room for reconnects.
 */
const HLS_PER_STREAM = 120;
const limitOf = (cls: RateClass) => (cls === "hls" ? maxStreams() * HLS_PER_STREAM : LIMITS[cls]);
const buckets = new Map<string, { n: number; reset: number }>();
/** Fixed-window limiter. Enough to blunt brute force and runaway clients. */
function rateLimit(key: string, cls: RateClass) {
  const t = Date.now(), k = `${cls}:${key}`;
  let b = buckets.get(k);
  if (!b || t > b.reset) buckets.set(k, (b = { n: 0, reset: t + 60_000 }));
  if (buckets.size > 10_000) for (const [key, v] of buckets) if (t > v.reset) buckets.delete(key);
  if (++b.n > limitOf(cls)) throw new HttpError(429, "rate_limited", "Too many requests. Try again in a moment.");
}
/** One session's use of each signed-in class this minute, for the diagnostics route. */
function rateUsage(key: string) {
  const t = Date.now();
  return (["read", "write", "media", "hls"] as const).map((cls) => {
    const b = buckets.get(`${cls}:${key}`), live = !!b && t <= b.reset;
    return { class: cls, used: live ? b!.n : 0, limit: limitOf(cls), resetSeconds: live ? Math.ceil((b!.reset - t) / 1000) : 0 };
  });
}
/**
 * The client's address: the last `X-Forwarded-For` entry, which the nearest proxy (cloudflared, a
 * reverse proxy) appends; entries before it are whatever the client sent. Next fills the header in
 * from the connection when a request arrives without one. A client that reaches Unifeye directly,
 * with no proxy in between, can still choose this value.
 */
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",").map((a) => a.trim()).filter(Boolean).pop() || "local";

const camDto = (c: CameraInfo) => ({ id: c.id, name: c.name, tags: c.tags, missing: c.missing, online: !c.missing && c.meta.online === true, eventTypes: (c.meta.eventTypes as string[] | undefined) ?? [], hasLive: Array.isArray(c.meta.streams) && c.meta.streams.length > 0 });

/**
 * Builds the actor from the server-side session. Nothing the client sends (user id, role, camera
 * list, group list) is trusted. A preview token is honoured only for the administrator session it
 * was issued to; an invalid one fails the request instead of falling back to administrator access.
 *
 * With Cloudflare Access on, the request's path decides which identities it may carry:
 *  - with an Access token (it came through Cloudflare): only the session of exactly that
 *    Cloudflare identity, and the token must verify on this request;
 *  - without one (it reached Unifeye some other way, such as the local network): only a password
 *    session. A Cloudflare session presented without a token is refused, never trusted.
 */
async function authenticate(req: Request, url: URL, s: Services, ip: string, requestId: string) {
  const unauthenticated = () => new HttpError(401, "unauthenticated", "Sign in required");
  const session = s.sessions.load(readCookie(req, SESSION_COOKIE), false);
  const user = session && s.policy.activeUser(session.userId);
  if (!session || !user) throw unauthenticated();
  if (signInMethods().cloudflare) {
    const ch = s.cloudflare.channel(req);
    if (ch.via === "forged") throw unauthenticated();
    if (ch.via === "cloudflare") {
      const id = await s.cloudflare.verify(ch.assertion);
      if (!id || !s.cloudflare.accept(session, user, id)) throw unauthenticated();
    } else if (user.authMethod !== "local") throw unauthenticated();
  }
  s.sessions.touch(session);
  const actor: Actor = { userId: user.id, role: user.role, sessionId: session.id, requestId, ip };
  const pv = req.headers.get("x-unifeye-preview") ?? url.searchParams.get("pv");
  if (pv) { const p = s.previews.resolve(session.id, user.id, pv); actor.preview = { id: p.id, subjectId: p.subjectId }; }
  return { session, user, actor };
}

/** Entry point for every /api request. Also used directly by the integration tests. */
export async function handleApi(req: Request): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/^\/api/, "") || "/", requestId = req.headers.get("x-request-id")?.slice(0, 64) || newId();
  const ip = clientIp(req);
  const started = Date.now();
  let res: Response;
  try {
    const match = routes.map((r) => ({ r, m: r.method === req.method ? r.re.exec(path) : null })).find((x) => x.m);
    if (!match) throw notFound();
    const { r, m } = match, s = services(), write = req.method !== "GET" && req.method !== "HEAD";
    const cls = r.opts.rate ?? (write ? "write" : "read");
    if (r.opts.public) rateLimit(`ip:${ip}`, cls);
    const p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m![i + 1])]));
    let auth: Awaited<ReturnType<typeof authenticate>> | undefined;
    if (!r.opts.public) {
      // Requests that fail to sign in count per address. Only failures count, so a signed-out tab
      // never blocks people signed in from the same address.
      auth = await authenticate(req, url, s, ip, requestId).catch((e) => { rateLimit(`ip:${ip}`, "unauth"); throw e; });
      rateLimit(`session:${auth.session.id}`, cls);
      if (write) {
        // CSRF: cookie-authenticated writes need the per-session token and a same-origin request.
        const origin = req.headers.get("origin");
        if (origin && !allowedOrigins().includes(origin)) throw forbidden("bad_origin");
        if (!safeEqual(req.headers.get("x-csrf-token") ?? "", auth.session.csrfSecret)) throw forbidden("bad_csrf_token");
      }
      if (r.opts.admin && (auth.actor.preview || !s.policy.isAdmin(auth.user.id))) {
        audit(s.db, { actorId: auth.user.id, previewSubjectId: auth.actor.preview?.subjectId, action: "admin.access", outcome: "denied", requestId, ip, detail: { path } });
        throw forbidden();
      }
    }
    const out = await r.fn({ req, url, p, s, actor: auth?.actor as Actor, session: auth?.session as SessionRow, user: auth?.user as UserRow, ip, requestId, json: async () => { try { return await req.json(); } catch { throw badRequest("Invalid JSON"); } } });
    res = out instanceof Response ? out : json(out ?? { ok: true });
  } catch (e) {
    // Checked by shape, not `instanceof`: the server bundles this module more than once (start-up and routes).
    const x = e as { status?: unknown; code?: unknown; message?: string; name?: string; issues?: { message: string }[] };
    if (typeof x?.status === "number" && typeof x.code === "string") res = json({ error: x.code, message: x.message ?? x.code }, x.status);
    else if (e instanceof ZodError || x?.name === "ZodError") res = json({ error: "bad_request", message: x.issues?.[0]?.message ?? "Invalid input" }, 400);
    else { log("error", "unhandled api error", { requestId, path, error: e }); res = json({ error: "internal", message: "Something went wrong" }, 500); }
  }
  try { res.headers.set("x-request-id", requestId); } catch { /* immutable upstream headers */ }
  if (!/^\/(health|ready|media\/live\/[^/]+\/hls)/.test(path)) log("debug", "request", { requestId, method: req.method, path, status: res.status, ms: Date.now() - started });
  return res;
}

// ---- authentication -------------------------------------------------------------
/**
 * Where a signed-out browser is sent. Through Cloudflare Access the person is signed in at once;
 * with only the identity provider on, straight to it (as before); with passwords on, to the sign-in
 * page, which offers the identity provider too when both are on.
 */
route("GET", "/auth/login", { public: true, rate: "auth" }, async ({ s, req, url, ip }) => {
  const m = signInMethods(), returnTo = safeReturnTo(url.searchParams.get("returnTo")), ch = s.cloudflare.channel(req);
  if (ch.via === "forged") {
    log("warn", "request with a Cloudflare Access token but without the origin secret refused");
    return redirect("/signed-out?error=login_failed");
  }
  if (ch.via === "cloudflare") {
    try {
      const r = await s.cloudflare.signIn(ch.assertion, { userAgent: req.headers.get("user-agent") ?? undefined, ip, previousSessionToken: readCookie(req, SESSION_COOKIE) });
      maybeSeedDemo(s);
      return redirect(returnTo, [cookie(SESSION_COOKIE, r.token, config().SESSION_ABSOLUTE_HOURS * 3600)]);
    } catch (e) {
      const reason = (e as { reason?: unknown })?.reason;
      if (typeof reason !== "string") log("warn", "Cloudflare sign-in failed", { error: e });
      return redirect(`/signed-out?error=${reason === "user_disabled" ? "not_admitted" : "login_failed"}`);
    }
  }
  if (m.oidc && (!m.local || url.searchParams.get("with") === "oidc")) {
    try {
      const { url: to, cookie: txn } = await s.oidc.begin(returnTo);
      return redirect(to, [cookie(LOGIN_TXN_COOKIE, txn, 600, "/api/auth")]);
    } catch (e) {
      log("warn", "login could not start", { error: e });
      return redirect("/signed-out?error=sso_unavailable"); // passwords are never a fallback for these accounts
    }
  }
  if (m.local) return redirect(`/sign-in${returnTo === "/" ? "" : `?returnTo=${encodeURIComponent(returnTo)}`}`);
  return redirect("/signed-out?error=cloudflare_required");
});
route("GET", "/auth/callback", { public: true, rate: "auth" }, async ({ s, req, url, ip }) => {
  const clear = cookie(LOGIN_TXN_COOKIE, "", 0, "/api/auth");
  try {
    const r = await s.oidc.complete(new URL(url.pathname + url.search, config().APP_URL), readCookie(req, LOGIN_TXN_COOKIE), { userAgent: req.headers.get("user-agent") ?? undefined, ip, previousSessionToken: readCookie(req, SESSION_COOKIE) });
    maybeSeedDemo(s);
    return redirect(r.returnTo, [clear, cookie(SESSION_COOKIE, r.token, config().SESSION_ABSOLUTE_HOURS * 3600)]);
  } catch (e) {
    const reason = (e as { reason?: unknown })?.reason;
    if (typeof reason !== "string") log("warn", "login callback failed", { error: e });
    const code = typeof reason === "string" ? (["not_admitted", "user_disabled"].includes(reason) ? "not_admitted" : "login_failed") : "sso_unavailable";
    return redirect(`/signed-out?error=${code}`, [clear]);
  }
});
route("POST", "/auth/logout", {}, async ({ s, session, user }) => {
  let to = "/signed-out";
  if (user.authMethod === "oidc") to = await s.oidc.logout(session);
  else {
    s.sessions.revoke(session.id, "logout");
    audit(s.db, { actorId: user.id, action: "auth.logout", targetType: "session", targetId: session.id });
    // Ends the Cloudflare Access session too, or Access would sign the person straight back in.
    if (user.authMethod === "cloudflare") to = "/cdn-cgi/access/logout";
  }
  return json({ redirect: to }, 200, { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
});

/**
 * Password sign-in routes exist only while SIGN_IN_METHODS includes `local`. They take no session,
 * so instead of the CSRF token they need a JSON body (which a cross-site form cannot send without a
 * preflight) and an Origin header naming one of Unifeye's own addresses. A request that came through
 * Cloudflare Access is refused: through Cloudflare, only Cloudflare identities sign in.
 */
async function passwordRequest(req: Request, s: Services) {
  if (!signInMethods().local) throw notFound();
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) throw forbidden("bad_origin");
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) throw badRequest("Invalid request");
  if (s.cloudflare.channel(req).via !== "direct") throw forbidden("use_cloudflare");
  // Small fixed bodies only. Browsers always send a length for a fetch with a string body.
  const len = Number(req.headers.get("content-length"));
  if (!(len > 0 && len <= 4096)) throw badRequest("Invalid request");
  const text = await req.text();
  if (text.length > 4096) throw badRequest("Invalid request");
  try { const b = JSON.parse(text) as unknown; if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* below */ }
  throw badRequest("Invalid JSON");
}
const signedIn = (token: string, returnTo: unknown) => json({ redirect: safeReturnTo(typeof returnTo === "string" ? returnTo : "/") }, 200, { "set-cookie": cookie(SESSION_COOKIE, token, config().SESSION_ABSOLUTE_HOURS * 3600) });
route("POST", "/auth/password", { public: true, rate: "auth" }, async ({ s, req, ip }) => {
  const b = await passwordRequest(req, s);
  const r = await s.local.signIn(b.username, b.password, { ip, userAgent: req.headers.get("user-agent") ?? undefined, previousSessionToken: readCookie(req, SESSION_COOKIE) });
  maybeSeedDemo(s);
  return signedIn(r.token, b.returnTo);
});
route("POST", "/auth/password-link/check", { public: true, rate: "auth" }, async ({ s, req }) => s.local.inspectLink((await passwordRequest(req, s)).token));
route("POST", "/auth/password-link", { public: true, rate: "auth" }, async ({ s, req, ip }) => {
  const b = await passwordRequest(req, s);
  const r = await s.local.useLink(b.token, b.password, { ip, userAgent: req.headers.get("user-agent") ?? undefined, previousSessionToken: readCookie(req, SESSION_COOKIE) });
  return signedIn(r.token, "/");
});
/**
 * Email codes. The browser that asks keeps a secret in a cookie that only the sign-in routes see
 * (SameSite=Strict); the code works only together with it. Asking always gives the same answer,
 * and the email goes out after the answer is sent.
 */
const CODE_PATH = "/api/auth";
const codeCookie = (value: string, maxAgeSec: number) => `${CODE_COOKIE}=${value}; Path=${CODE_PATH}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure() ? "; Secure" : ""}`;
route("POST", "/auth/email", { public: true, rate: "auth" }, async ({ s, req, ip }) => {
  const b = await passwordRequest(req, s);
  if (!emailCodesOn()) throw notFound();
  const r = s.local.requestCode(b.username, { ip, userAgent: req.headers.get("user-agent") ?? undefined, timeZone: typeof b.timeZone === "string" ? b.timeZone : undefined });
  void r.sent; // not awaited: a slow mail server must not reveal that the account exists
  return json({ ok: true, expiresInSeconds: CODE_TTL_MS / 1000 }, 200, { "set-cookie": codeCookie(r.secret, CODE_TTL_MS / 1000) });
});
route("POST", "/auth/start", { public: true, rate: "auth" }, async ({ s, req, ip }) => {
  const b = await passwordRequest(req, s);
  const r = s.local.start(b.username, readCookie(req, CODE_COOKIE), { ip, userAgent: req.headers.get("user-agent") ?? undefined, timeZone: typeof b.timeZone === "string" ? b.timeZone : undefined });
  return "secret" in r && r.secret ? json({ next: r.next }, 200, { "set-cookie": codeCookie(r.secret, CODE_TTL_MS / 1000) }) : json({ next: r.next });
});
route("POST", "/auth/email/verify", { public: true, rate: "auth" }, async ({ s, req, ip }) => {
  const b = await passwordRequest(req, s);
  if (!emailCodesOn()) throw notFound();
  const r = s.local.verifyCode(readCookie(req, CODE_COOKIE), b.code, { ip, userAgent: req.headers.get("user-agent") ?? undefined, previousSessionToken: readCookie(req, SESSION_COOKIE) });
  maybeSeedDemo(s);
  const res = signedIn(r.token, b.returnTo);
  res.headers.append("set-cookie", codeCookie("", 0));
  return res;
});
route("POST", "/me/password", { rate: "auth" }, async ({ s, actor, user, session, ip, json: body }) => {
  if (actor.preview) throw forbidden("preview_read_only");
  if (user.authMethod !== "local") throw notFound();
  const b = await body<{ current?: unknown; next?: unknown }>();
  await s.local.changePassword(user.id, session.id, b.current, b.next, ip);
});
route("POST", "/auth/backchannel-logout", { public: true, rate: "auth" }, async ({ s, req }) => {
  const token = new URLSearchParams(await req.text()).get("logout_token");
  if (!token) throw new HttpError(400, "invalid_request");
  await s.oidc.backchannelLogout(token);
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
});

// ---- session bootstrap for the UI ---------------------------------------------
route("GET", "/me", {}, ({ s, actor, user, session }) => {
  const subject = subjectOf(actor), su = s.policy.activeUser(subject)!, c = config(), landing = s.views.landing(subject);
  return {
    user: { id: user.id, name: user.name || user.email || "You", role: user.role, signsInWith: user.authMethod, hasPassword: user.authMethod === "local" && s.local.hasPassword(user.id) },
    csrf: session.csrfSecret,
    preview: actor.preview ? { subject: { id: su.id, name: su.name } } : null,
    subject: { id: su.id, name: su.name, role: su.role, canCreateViews: su.role === "admin" || su.allowPrivateViews, canExportClips: s.policy.canExportClips(subject) },
    isAdmin: !actor.preview && user.role === "admin",
    landing,
    views: s.views.accessible(subject).map((v) => { const r = s.views.resolve(v, subject); return { id: v.id, name: v.name, type: v.type, visibility: v.visibility, columns: v.columns, count: r.cameras.length, editable: !actor.preview && r.editable }; }),
    preferences: s.admin.preferences(actor),
    mode: c.UNIFEYE_MODE,
    recorder: s.adapter.health().state,
    limits: { maxStreams: c.MAX_WALL_STREAMS, windowSeconds: c.PLAYBACK_WINDOW_SECONDS, prerollSeconds: c.EVENT_PREROLL_SECONDS, clipMaxSeconds: c.CLIP_MAX_SECONDS },
  };
});
route("PUT", "/preferences", {}, async ({ s, actor, json: body }) => { const b = await body<{ key: string; value: unknown }>(); s.admin.setPreference(actor, b.key, b.value); });
route("POST", "/preview", { admin: true }, async ({ s, actor, json: body }) => s.previews.start(actor, String((await body()).userId ?? "")));
route("DELETE", "/preview", {}, ({ s, actor }) => { s.previews.end(actor); });

// ---- cameras ------------------------------------------------------------------
route("GET", "/cameras", {}, ({ s, actor }) => ({ cameras: s.policy.cameras(subjectOf(actor)).map(camDto), recorder: s.adapter.health().state }));
// Which cameras are writing to the recorder right now. Administrators only, and not while previewing as staff.
route("GET", "/recording", { admin: true }, async ({ s }) => {
  const now = new Set(await s.adapter.recordingNow().catch(() => [] as string[]));
  return { cameraIds: s.policy.allCamerasUnchecked().filter((c) => !c.missing && c.nvrId === s.adapter.nvrId && now.has(c.protectId)).map((c) => c.id) };
});
route("GET", "/tags", {}, ({ s, actor }) => {
  const names = new Set(s.policy.cameras(subjectOf(actor)).flatMap((c) => c.tags));
  const all = s.db.select().from(schema.tags).all();
  return { tags: (!actor.preview && s.policy.isAdmin(actor.userId) ? all : all.filter((t) => names.has(t.name))).map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name)) };
});
route("GET", "/cameras/:id/snapshot", { rate: "media" }, async ({ s, actor, p, url, req }) => {
  const cam = s.policy.camera(subjectOf(actor), p.id), at = url.searchParams.get("at");
  const img = await s.adapter.snapshot(cam.protectId, { width: Number(url.searchParams.get("w")) || 640, atMs: at ? num(at, "at") : undefined, signal: req.signal }).catch(() => { throw new HttpError(404, "no_image"); });
  return new Response(new Uint8Array(img), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } });
});
route("GET", "/cameras/:id/recordings", {}, ({ s, actor, p, url }) => s.recordings.ranges(actor, p.id, num(url.searchParams.get("from"), "from"), num(url.searchParams.get("to"), "to")));
route("GET", "/cameras/:id/playback/info", { rate: "media" }, async ({ s, actor, p, url, req }) => (await s.recordings.window(actor, p.id, num(url.searchParams.get("t"), "t"), req.signal)).info);
route("GET", "/cameras/:id/playback", { rate: "media" }, async ({ s, actor, p, url, req }) => {
  const w = await s.recordings.window(actor, p.id, num(url.searchParams.get("t"), "t"), req.signal), file = url.searchParams.get("layer") === "high" ? w.high : w.base;
  if (!file) throw new HttpError(404, "no_recording", "Nothing recorded at this time");
  return fileResponse(file, req, "video/mp4", { "x-window-start": String(w.info.startMs), "x-window-end": String(w.info.endMs) });
});

// ---- live video -----------------------------------------------------------------
route("POST", "/media/live/:id/whep", { rate: "media" }, async ({ s, actor, p, url, req }) => {
  const r = await s.media.whepCreate(actor, p.id, quality(url.searchParams.get("q")), await req.text());
  return new Response(r.sdp, { status: 201, headers: { "content-type": "application/sdp", location: `/api/media/live/whep/${r.secret}`, "cache-control": "no-store", "x-video-source": r.source, ...(r.etag ? { etag: r.etag } : {}) } });
});
for (const method of ["PATCH", "DELETE"] as const)
  route(method, "/media/live/whep/:secret", { rate: "media" }, async ({ s, actor, p, req }) => {
    const h: Record<string, string> = {};
    for (const k of ["content-type", "if-match"]) { const v = req.headers.get(k); if (v) h[k] = v; }
    return new Response(null, { status: await s.media.whepForward(actor, p.secret, method, method === "PATCH" ? await req.text() : undefined, h) });
  });
route("DELETE", "/media/live/:id/hls/:q", { rate: "hls" }, async ({ s, actor, p }) => { await s.media.hlsClose(actor, p.id, quality(p.q)); });
route("GET", "/media/live/:id/hls/:q/:file", { rate: "hls" }, ({ s, actor, p, url }) => { const q = new URLSearchParams(url.search); q.delete("pv"); const qs = q.toString(); return s.media.hls(actor, p.id, quality(p.q), p.file, qs ? `?${qs}` : ""); });

// ---- views ------------------------------------------------------------------------
route("GET", "/views/:id", {}, ({ s, actor, p }) => {
  const subject = subjectOf(actor), v = s.views.canOpen(subject, p.id);
  if (!v) throw notFound();
  const r = s.views.resolve(v, subject), admin = !actor.preview && s.policy.isAdmin(actor.userId);
  const allowed = s.policy.cameraIds(subject);
  return {
    ...r, cameras: r.cameras.map(camDto), editable: !actor.preview && r.editable, version: v.version,
    // The stored definition, reduced to what this viewer may know about.
    definition: { tagIds: s.views.predicateTags(v.id).map((t) => t.id), cameraIds: s.views.staticCameraIds(v.id).filter((id) => allowed.has(id)) },
    sharing: admin && v.visibility === "curated" ? { all: v.sharedWithAll, userIds: s.db.select().from(schema.viewUserShares).all().filter((x) => x.viewId === v.id).map((x) => x.userId), groupIds: s.db.select().from(schema.viewGroupShares).all().filter((x) => x.viewId === v.id).map((x) => x.groupId) } : null,
  };
});
route("POST", "/views", {}, async ({ s, actor, json: body }) => { const b = await body<{ visibility?: string }>(); const v = s.admin.createView(actor, b as never, b.visibility === "curated" ? "curated" : "private"); return { id: v.id }; });
route("PUT", "/views/:id", {}, async ({ s, actor, p, json: body }) => { const b = await body<{ version: number }>(); s.admin.updateView(actor, p.id, b as never, Number(b.version)); });
route("DELETE", "/views/:id", {}, ({ s, actor, p }) => { s.admin.deleteView(actor, p.id); });
route("PUT", "/views/:id/sharing", { admin: true }, async ({ s, actor, p, json: body }) => { const b = await body<{ all?: boolean; userIds?: string[]; groupIds?: string[] }>(); s.admin.setSharing(actor, p.id, { all: !!b.all, userIds: b.userIds ?? [], groupIds: b.groupIds ?? [] }); });
route("PUT", "/defaults", {}, async ({ s, actor, json: body }) => {
  const b = await body<{ scope: string; userId?: string; groupId?: string; viewId: string | null }>();
  const target = b.scope === "org" ? { scope: "org" as const } : b.scope === "group" ? { scope: "group" as const, groupId: String(b.groupId) } : b.scope === "user" ? { scope: "user" as const, userId: String(b.userId) } : b.scope === "personal" ? { scope: "personal" as const } : null;
  if (!target) throw badRequest("Unknown scope");
  s.admin.setDefault(actor, target, b.viewId || null);
});

// ---- events ---------------------------------------------------------------------
route("GET", "/events", {}, ({ s, actor, url }) => {
  const q = url.searchParams, to = q.get("to") ? num(q.get("to"), "to") : Date.now();
  return s.events.list(actor, { cameraId: q.get("cameraId") || undefined, fromMs: q.get("from") ? num(q.get("from"), "from") : to - 864e5, toMs: to, types: q.getAll("type"), limit: Number(q.get("limit")) || undefined });
});
route("GET", "/events/stream", {}, ({ s, actor, req }) => {
  const enc = new TextEncoder();
  let off = () => {}, ping: NodeJS.Timeout | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const close = () => { clearInterval(ping); off(); try { ctrl.close(); } catch { /* closed */ } };
      const send = (t: string) => { try { ctrl.enqueue(enc.encode(t)); } catch { close(); } };
      send(": connected\n\n");
      off = s.events.subscribe(actor, (e) => send(`event: activity\ndata: ${JSON.stringify(e)}\n\n`), () => { send("event: ended\ndata: {}\n\n"); close(); });
      ping = setInterval(() => send(": keep-alive\n\n"), 20_000);
      req.signal.addEventListener("abort", close);
    },
    cancel() { clearInterval(ping); off(); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
route("GET", "/events/:id", {}, async ({ s, actor, p }) => (await s.events.get(actor, p.id)).dto);
route("GET", "/events/:id/thumbnail", { rate: "media" }, async ({ s, actor, p, req }) => new Response(new Uint8Array(await s.events.thumbnail(actor, p.id, req.signal)), { headers: { "content-type": "image/jpeg", "cache-control": "private, no-store" } }));

// ---- clip export -----------------------------------------------------------------
const jobDto = (j: { id: string; status: string; progress: number; error: string | null; durationMs: number | null; gap: string | null; expiresAt: number }) => ({ id: j.id, status: j.status, progress: j.progress, error: j.error, durationMs: j.durationMs, gap: j.gap, expiresAt: j.expiresAt });
route("POST", "/exports", { rate: "media" }, async ({ s, actor, json: body }) => { const b = await body<{ cameraId: string; startMs: number; endMs: number }>(); return s.recordings.createExport(actor, String(b.cameraId), Number(b.startMs), Number(b.endMs)); });
route("GET", "/exports/:id", {}, async ({ s, actor, p }) => {
  const j = s.recordings.exportJob(actor, p.id), file = j.status === "ready" ? s.recordings.downloadPath(actor, j.id) : null;
  return { ...jobDto(j), etaMs: j.status === "running" && j.progress < 95 ? s.recordings.exportEta(j.id) : null, fileName: file?.name ?? null, bytes: file ? ((await stat(file.file).catch(() => null))?.size ?? null) : null };
});
route("DELETE", "/exports/:id", {}, ({ s, actor, p }) => { s.recordings.cancelExport(actor, p.id); });
route("GET", "/exports/:id/download", { rate: "media" }, ({ s, actor, p, req }) => { const d = s.recordings.downloadPath(actor, p.id); return fileResponse(d.file, req, "video/mp4", { "content-disposition": `attachment; filename="${d.name}"` }); });

// ---- administration (never available during a preview) -----------------------------
route("GET", "/admin/overview", { admin: true }, ({ s }) => {
  const users = s.db.select().from(schema.users).all(), groups = s.db.select().from(schema.groups).all();
  const members = s.db.select().from(schema.groupMembers).all(), defaults = s.db.select().from(schema.defaultViews).all();
  const creds = new Map(s.db.select().from(schema.localCredentials).all().map((x) => [x.userId, x])), methods = signInMethods();
  const viewName = new Map(s.db.select().from(schema.views).all().map((v) => [v.id, v.name]));
  return {
    users: users.map((u) => { const l = s.views.landing(u.id); return { id: u.id, name: u.name, email: u.email, username: creds.get(u.id)?.username ?? null, passwordSet: !!creds.get(u.id)?.passwordHash, passwordAllowed: creds.get(u.id)?.passwordAllowed ?? false, codeEmails: creds.get(u.id)?.codeEmails ?? [], signsInWith: u.authMethod, methodOn: methods[u.authMethod], role: u.role, status: u.status, allowPrivateViews: u.allowPrivateViews, canExportClips: s.policy.canExportClips(u.id), lastLoginAt: u.lastLoginAt, providerGroups: u.providerGroups, groupIds: members.filter((m) => m.userId === u.id).map((m) => m.groupId), cameraCount: s.policy.cameraIds(u.id).size, landing: { ...l, viewName: l.viewId ? viewName.get(l.viewId) : null, groupName: groups.find((g) => g.id === l.groupId)?.name ?? null } }; }),
    groups: groups.map((g) => ({ id: g.id, name: g.name, defaultPriority: g.defaultPriority, isAllStaff: g.isAllStaff, providerValues: g.providerValues, canExportClips: g.canExportClips, memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId), syncedMemberIds: members.filter((m) => m.groupId === g.id && m.source === "provider").map((m) => m.userId) })),
    groupSync: { claim: groupsClaim() },
    signIn: { ...methods, oidcName: config().OIDC_DISPLAY_NAME, email: emailCodesOn() },
    // Only whether email is going out, for a warning: never addresses or contents.
    mail: ((h) => ({ failing: !!h.lastErrorAt && (!h.lastOkAt || h.lastErrorAt > h.lastOkAt) }))(s.mailer.health()),
    cameras: s.policy.allCamerasUnchecked().map(camDto).sort((a, b) => a.name.localeCompare(b.name)),
    tags: s.db.select().from(schema.tags).all().map((t) => ({ id: t.id, name: t.name })).sort((a, b) => a.name.localeCompare(b.name)),
    cameraTags: s.db.select().from(schema.cameraTags).all(),
    userGrants: s.db.select().from(schema.userCameraGrants).all().map((x) => ({ userId: x.userId, cameraId: x.cameraId })),
    groupGrants: s.db.select().from(schema.groupCameraGrants).all().map((x) => ({ groupId: x.groupId, cameraId: x.cameraId })),
    views: s.db.select().from(schema.views).all().filter((v) => v.visibility === "curated").map((v) => ({ id: v.id, name: v.name, sharedWithAll: v.sharedWithAll })),
    defaults: defaults.map((d) => ({ scope: d.scope, userId: d.userId, groupId: d.groupId, viewId: d.viewId })),
    // Never a password: only whether one is set.
    direct: {
      capable: s.policy.allCamerasUnchecked().filter((c) => c.meta.direct === true).map((c) => c.id),
      defaultUsername: config().DEFAULT_CAMERA_USERNAME ?? null, defaultPassword: !!config().DEFAULT_CAMERA_PASSWORD, canSavePassword: !!config().TOKEN_ENC_KEY,
      cameras: s.media.direct.settings(),
    },
  };
});
route("POST", "/admin/users", { admin: true }, async ({ s, actor, json: body }) => s.admin.createPasswordUser(actor, await body()));
route("POST", "/admin/users/:id/password-link", { admin: true }, ({ s, actor, p }) => s.admin.passwordLink(actor, p.id));
route("PUT", "/admin/users/:id/sign-in", { admin: true }, async ({ s, actor, p, json: body }) => s.admin.setSignIn(actor, p.id, await body()));
route("PATCH", "/admin/users/:id", { admin: true }, async ({ s, actor, p, json: body }) => { s.admin.updateUser(actor, p.id, await body()); });
route("POST", "/admin/groups", { admin: true }, async ({ s, actor, json: body }) => s.admin.createGroup(actor, String((await body()).name ?? "")));
route("PATCH", "/admin/groups/:id", { admin: true }, async ({ s, actor, p, json: body }) => { s.admin.updateGroup(actor, p.id, await body()); });
route("DELETE", "/admin/groups/:id", { admin: true }, ({ s, actor, p }) => { s.admin.deleteGroup(actor, p.id); });
route("PUT", "/admin/members", { admin: true }, async ({ s, actor, json: body }) => { const b = await body<{ groupId: string; userId: string; on: boolean }>(); s.admin.setMember(actor, String(b.groupId), String(b.userId), !!b.on); });
route("PUT", "/admin/grants", { admin: true }, async ({ s, actor, json: body }) => {
  const b = await body<{ userId?: string; groupId?: string; cameraId?: string; cameraIds?: string[]; on: boolean }>();
  if (!b.userId === !b.groupId) throw badRequest("Give a user or a group");
  if (b.cameraIds !== undefined && !Array.isArray(b.cameraIds)) throw badRequest("cameraIds must be a list");
  const ids = b.cameraIds ? b.cameraIds.map(String) : [String(b.cameraId)];
  s.admin.setGrants(actor, b.userId ? { userId: b.userId } : { groupId: b.groupId! }, ids, !!b.on);
});
route("POST", "/admin/tags", { admin: true }, async ({ s, actor, json: body }) => s.admin.createTag(actor, String((await body()).name ?? "")));
route("PATCH", "/admin/tags/:id", { admin: true }, async ({ s, actor, p, json: body }) => { s.admin.renameTag(actor, p.id, String((await body()).name ?? "")); });
route("DELETE", "/admin/tags/:id", { admin: true }, ({ s, actor, p }) => { s.admin.deleteTag(actor, p.id); });
route("PUT", "/admin/camera-tags", { admin: true }, async ({ s, actor, json: body }) => { const b = await body<{ cameraId: string; tagId: string; on: boolean }>(); s.admin.setCameraTag(actor, String(b.cameraId), String(b.tagId), !!b.on); });
/**
 * Turning direct video on first asks the camera to describe its streams with the login that would be
 * used, so a wrong password or an unplayable format is reported here rather than as a blank tile.
 */
route("PUT", "/admin/cameras/:id/direct", { admin: true }, async ({ s, actor, p, json: body }) => {
  const b = await body<{ enabled?: unknown; username?: unknown; password?: unknown }>();
  const field = (v: unknown) => (typeof v === "string" || v === null ? v : undefined);
  const input = { enabled: b.enabled === true, username: field(b.username), password: field(b.password) };
  const cam = s.policy.allCamerasUnchecked().find((c) => c.id === p.id);
  if (!cam) throw notFound();
  if (input.enabled) {
    if (cam.meta.direct !== true) throw badRequest(DIRECT_PROBLEM.unsupported);
    const login = s.media.direct.resolve(s.media.direct.stored(cam.id), input);
    if (!login) throw badRequest(DIRECT_PROBLEM.no_login);
    const r = await s.adapter.checkDirect(cam.protectId, login).catch(() => ({ ok: false as const, reason: "unreachable" as const }));
    if (!r.ok) throw badRequest(DIRECT_PROBLEM[r.reason]);
  }
  s.admin.setCameraDirect(actor, cam.id, input);
  s.media.direct.reset(cam.id);
});
route("GET", "/admin/audit", { admin: true }, ({ s, url }) => {
  const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
  const names = new Map(s.db.select().from(schema.users).all().map((u) => [u.id, u.name || u.email || u.id]));
  const rows = s.db.select().from(schema.auditLog).where(lt(schema.auditLog.id, before)).orderBy(desc(schema.auditLog.id)).limit(100).all();
  return { entries: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actorId ? names.get(r.actorId) ?? "Removed user" : "System", previewSubject: r.previewSubjectId ? names.get(r.previewSubjectId) ?? null : null, action: r.action, targetType: r.targetType, targetId: r.targetId, outcome: r.outcome, detail: r.detail }) ) };
});

// ---- diagnostics: this session only ------------------------------------------------
/**
 * What the diagnostics window needs from the server: its clock, whether the recorder and the media
 * relay are reachable, this session's open live streams and its use of the per-minute limits, and
 * which build this is and whether a newer one exists (`version.ts`). Only
 * the caller's own session; nothing about other people, no configuration values beyond the limits
 * that apply to the caller, and only stream cameras the effective subject can see. A read, so it
 * works during "See as staff"; the counts are the administrator's session's, which the preview shares.
 */
route("GET", "/diagnostics", {}, async ({ s, actor, session }) => {
  const visible = s.policy.cameraIds(subjectOf(actor)), streams = s.media.sessionStreams(session.id);
  return {
    serverTime: Date.now(),
    ...versionInfo(),
    recorder: s.adapter.health().state,
    relay: await s.media.relayHealthy().catch(() => false),
    streams: {
      limit: maxStreams(), open: streams.length,
      webrtc: streams.filter((x) => x.kinds.includes("webrtc")).length, hls: streams.filter((x) => x.kinds.includes("hls")).length,
      held: streams.filter((x) => visible.has(x.cameraId)).map((x) => ({ cameraId: x.cameraId, quality: x.quality, kinds: x.kinds })),
    },
    rate: rateUsage(`session:${session.id}`),
  };
});
/** Largest download-speed sample, and the default. Each test also counts against `speedtest` (10 a minute). */
export const SPEED_TEST_MAX_BYTES = 4 * 1024 * 1024;
const SPEED_TEST_DEFAULT_BYTES = 2 * 1024 * 1024;
/**
 * Random bytes for the download-speed check, so no proxy can compress them. Capped at
 * SPEED_TEST_MAX_BYTES whatever is asked, counted as media, and limited to a few a minute per session.
 */
route("GET", "/diagnostics/download", { rate: "media" }, ({ session, url }) => {
  rateLimit(`session:${session.id}`, "speedtest");
  const asked = Number(url.searchParams.get("bytes"));
  const size = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(Math.floor(asked), 64 * 1024), SPEED_TEST_MAX_BYTES) : SPEED_TEST_DEFAULT_BYTES;
  return new Response(new Uint8Array(randomBytes(size)), { headers: { "content-type": "application/octet-stream", "content-length": String(size), "cache-control": "no-store, no-transform" } });
});

// ---- health (no secrets, no configuration values) ----------------------------------
route("GET", "/health", { public: true }, () => ({ ok: true }));
route("GET", "/ready", { public: true }, async ({ s }) => {
  let database = false;
  try { database = s.db.$client.prepare("select 1 x").get() != null; } catch { /* reported below */ }
  const h = s.adapter.health(), b = backupStatus(), relay = await s.media.relayHealthy();
  const body = { database, recorder: { mode: h.mode, state: h.state, lastOkAt: h.lastOkAt }, relay, lastCameraSyncAt: s.state.lastCameraSyncAt, backup: b ? { ok: b.ok, at: b.at } : null, ...s.media.stats() };
  return json(body, database ? 200 : 503);
});
