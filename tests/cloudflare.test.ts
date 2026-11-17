import { eq } from "drizzle-orm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { loadConfig, setConfigForTests } from "@/server/config";
import { schema } from "@/server/db";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

/**
 * Cloudflare Access in front of Unifeye, with password accounts for the local network. The team's
 * signing keys are served by a stubbed fetch; nothing here talks to Cloudflare.
 */
const TEAM = "acme.cloudflareaccess.com", ISS = `https://${TEAM}`, AUD = "aud-tag-1", APP = "https://cams.example", EDGE = "e".repeat(40);
type KP = Awaited<ReturnType<typeof generateKeyPair>>;
let good: KP, evil: KP, f: Fixture, n = 0, clientIp = "", certFetches = 0;
const env = (over: Record<string, string> = {}) => setConfigForTests(loadConfig({ ...TEST_ENV, APP_URL: APP, SIGN_IN_METHODS: "cloudflare,local", CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD, CF_ACCESS_ORIGIN_SECRET: EDGE, ...over } as unknown as NodeJS.ProcessEnv));

async function access(claims: Record<string, unknown> = {}, o: { key?: KP; kid?: string; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: ISS, aud: [AUD], sub: "cf-user-1", email: "jordan@acme.example", iat: now, nbf: now, exp: now + 3600, type: "app", ...claims })
    .setProtectedHeader({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1" }).sign((o.key ?? good).privateKey);
}
type Opts = { cookie?: string; csrf?: string; jwt?: string; body?: unknown; headers?: Record<string, string> };
async function call(method: string, path: string, o: Opts = {}) {
  const h: Record<string, string> = { origin: APP, "x-forwarded-for": clientIp, ...o.headers };
  if (o.cookie) h.cookie = `unifeye_session=${o.cookie}`;
  if (o.csrf) h["x-csrf-token"] = o.csrf;
  if (o.jwt !== undefined) { h["cf-access-jwt-assertion"] = o.jwt; h["x-unifeye-origin-secret"] ??= EDGE; } // what Cloudflare's edge adds
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  if (body !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(body)); }
  const res = await handleApi(new Request(`${APP}/api${path}`, { method, headers: h, body }));
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { res, status: res.status, data: text ? JSON.parse(text) : undefined, location: res.headers.get("location"), cookie: /unifeye_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] };
}
/** What the browser does: hit /me, get 401, go to /auth/login, come back with a cookie. */
async function cfSignIn(jwt: string, returnTo = "/") {
  const r = await call("GET", `/auth/login?returnTo=${encodeURIComponent(returnTo)}`, { jwt });
  return r;
}

beforeAll(async () => {
  good = await generateKeyPair("RS256"); evil = await generateKeyPair("RS256");
});
beforeEach(() => {
  clientIp = `203.0.113.${++n}`;
  certFetches = 0;
  f = makeFixture();
  env();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    if (String(url) !== `${ISS}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
    certFetches++;
    return new Response(JSON.stringify({ keys: [{ ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] }), { headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Cloudflare Access sign-in", () => {
  it("signs a person in from a valid Access token, keyed by team issuer + subject, with no access", async () => {
    const r = await cfSignIn(await access(), "/activity");
    expect(r.status).toBe(302);
    expect(r.location).toBe("/activity");
    expect(r.cookie).toBeTruthy();
    const u = f.db.select().from(schema.users).where(eq(schema.users.subject, "cf-user-1")).get()!;
    expect(u).toMatchObject({ issuer: ISS, authMethod: "cloudflare", role: "staff", email: "jordan@acme.example" });
    expect(f.policy.cameraIds(u.id).size).toBe(f.policy.cameraIds(f.u.nobody).size);
    expect(certFetches).toBe(1);
    const me = await call("GET", "/me", { cookie: r.cookie, jwt: await access() });
    expect(me.status).toBe(200);
    expect(me.data.user.signsInWith).toBe("cloudflare");
  });
  it("refuses forged, foreign, expired and subject-less tokens at sign-in", async () => {
    const bad = [
      await access({}, { key: evil }), // wrong signature
      await access({ iss: "https://other.cloudflareaccess.com" }),
      await access({ aud: ["someone-elses-app"] }),
      await access({ exp: Math.floor(Date.now() / 1000) - 120 }),
      await access({ sub: "" }), // service tokens carry no subject
      await access({}, { kid: "unknown" }),
      "not-a-jwt",
    ];
    for (const jwt of bad) {
      const r = await cfSignIn(jwt);
      expect([r.status, r.location, r.cookie], jwt.slice(0, 20)).toEqual([302, "/signed-out?error=login_failed", undefined]);
    }
    expect(f.db.select().from(schema.users).where(eq(schema.users.issuer, ISS)).all()).toEqual([]);
  });
  it("re-checks the token on every request and only for the identity that owns the session", async () => {
    const s = await cfSignIn(await access());
    expect((await call("GET", "/cameras", { cookie: s.cookie, jwt: await access() })).status).toBe(200);
    expect((await call("GET", "/cameras", { cookie: s.cookie, jwt: await access({ sub: "cf-user-2" }) })).status).toBe(401); // someone else's token
    expect((await call("GET", "/cameras", { cookie: s.cookie, jwt: await access({}, { key: evil }) })).status).toBe(401);
    expect((await call("GET", "/cameras", { cookie: s.cookie, jwt: await access({ exp: Math.floor(Date.now() / 1000) - 120 }) })).status).toBe(401);
    // Without the header the request did not come through Cloudflare: a Cloudflare session is never accepted there.
    expect((await call("GET", "/cameras", { cookie: s.cookie })).status).toBe(401);
    expect((await call("GET", "/cameras", { cookie: s.cookie, jwt: await access() })).status).toBe(200);
  });
  it("a different person behind the same browser gets their own session, and the old one ends", async () => {
    const a = await cfSignIn(await access());
    const b = await call("GET", "/auth/login", { cookie: a.cookie, jwt: await access({ sub: "cf-user-2", email: "sam@acme.example" }) });
    expect(b.cookie).toBeTruthy();
    expect((await call("GET", "/me", { cookie: a.cookie, jwt: await access() })).status).toBe(401);
    expect((await call("GET", "/me", { cookie: b.cookie, jwt: await access({ sub: "cf-user-2" }) })).data.user.signsInWith).toBe("cloudflare");
  });
  it("suspends a session not seen through Cloudflare for CF_ACCESS_RECHECK_SECONDS, which stops its media", async () => {
    const s = await cfSignIn(await access());
    const row = f.sessions.load(s.cookie, false)!;
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 301_000 }).where(eq(schema.sessions.id, row.id)).run();
    expect(f.sessions.isLive(row.id)).toBe(false);
    expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access() })).status).toBe(401);
    // The browser goes back through /auth/login and gets a fresh session.
    const again = await cfSignIn(await access());
    expect((await call("GET", "/me", { cookie: again.cookie, jwt: await access() })).status).toBe(200);
  });
  it("valid requests keep the session validated", async () => {
    const s = await cfSignIn(await access());
    const row = f.sessions.load(s.cookie, false)!;
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 200_000 }).where(eq(schema.sessions.id, row.id)).run();
    expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access() })).status).toBe(200);
    expect(Date.now() - f.sessions.byId(row.id)!.lastValidatedAt).toBeLessThan(5000);
  });
  it("a disabled person is sent to the signed-out page", async () => {
    const s = await cfSignIn(await access());
    const id = f.sessions.load(s.cookie, false)!.userId;
    f.db.update(schema.users).set({ status: "disabled" }).where(eq(schema.users.id, id)).run();
    f.policy.invalidate();
    expect((await cfSignIn(await access())).location).toBe("/signed-out?error=not_admitted");
  });
  it("never takes over a profile from another sign-in method with the same issuer and subject", async () => {
    const t = Date.now();
    f.db.insert(schema.users).values({ id: "planted", issuer: ISS, subject: "cf-user-1", name: "Old", role: "admin", authMethod: "oidc", createdAt: t, updatedAt: t }).run();
    expect((await cfSignIn(await access())).location).toBe("/signed-out?error=login_failed");
  });
  it("bootstraps the first administrator by exact team issuer and subject", async () => {
    env({ BOOTSTRAP_ADMIN_ISSUER: ISS, BOOTSTRAP_ADMIN_SUBJECT: "cf-user-1" });
    const s = await cfSignIn(await access());
    expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access() })).data.isAdmin).toBe(true);
  });
  it("sign-out ends the session and also signs out of Cloudflare Access", async () => {
    const s = await cfSignIn(await access());
    const me = await call("GET", "/me", { cookie: s.cookie, jwt: await access() });
    const r = await call("POST", "/auth/logout", { cookie: s.cookie, csrf: me.data.csrf, jwt: await access() });
    expect(r.data.redirect).toBe("/cdn-cgi/access/logout");
    expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access() })).status).toBe(401);
  });
});

describe("Cloudflare with passwords for the local network", () => {
  async function passwordUser() {
    const t = Date.now();
    f.db.insert(schema.users).values({ id: "admin-cf", issuer: ISS, subject: "cf-admin", name: "CF Admin", role: "admin", authMethod: "cloudflare", createdAt: t, updatedAt: t }).run();
    f.policy.invalidate();
    const adminJwt = await access({ sub: "cf-admin" });
    const a = await cfSignIn(adminJwt);
    const csrf = (await call("GET", "/me", { cookie: a.cookie, jwt: adminJwt })).data.csrf;
    const created = await call("POST", "/admin/users", { cookie: a.cookie, csrf, jwt: adminJwt, body: { name: "Guard", username: "guard" } });
    expect(created.status).toBe(200);
    const token = new URL(created.data.link.url).hash.slice(1);
    const set = await call("POST", "/auth/password-link", { body: { token, password: "correct horse battery" } });
    expect(set.status).toBe(200);
    return { cookie: set.cookie! };
  }
  it("password sessions work only without the Cloudflare header", async () => {
    const p = await passwordUser();
    expect((await call("GET", "/me", { cookie: p.cookie })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: p.cookie, jwt: await access() })).status).toBe(401);
  });
  it("password sign-in is refused for requests that came through Cloudflare", async () => {
    await passwordUser();
    const r = await call("POST", "/auth/password", { body: { username: "guard", password: "correct horse battery" }, jwt: await access() });
    expect([r.status, r.data.error]).toEqual([403, "use_cloudflare"]);
    expect((await call("POST", "/auth/password", { body: { username: "guard", password: "correct horse battery" } })).status).toBe(200);
  });
  it("a signed-out browser without the header is sent to the password page", async () => {
    expect((await call("GET", "/auth/login?returnTo=/activity")).location).toBe("/sign-in?returnTo=%2Factivity");
  });
  it("an invalid header never falls back to the password page", async () => {
    expect((await cfSignIn(await access({}, { key: evil }))).location).toBe("/signed-out?error=login_failed");
    expect((await cfSignIn("")).location).toBe("/signed-out?error=login_failed");
  });
  it("a valid token sent straight to the server, without Cloudflare's origin secret, is refused", async () => {
    const s = await cfSignIn(await access());
    for (const secret of ["", "wrong", EDGE.slice(1)]) {
      const headers = { "x-unifeye-origin-secret": secret };
      expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access(), headers })).status, secret).toBe(401);
      expect((await call("GET", "/auth/login", { jwt: await access(), headers })).location).toBe("/signed-out?error=login_failed");
      expect((await call("POST", "/auth/password", { jwt: await access(), headers, body: { username: "a", password: "b" } })).data.error).toBe("use_cloudflare");
    }
    // Cloudflare's secret without an Access token: something Access did not cover. Fails closed.
    const edgeOnly = { "x-unifeye-origin-secret": EDGE };
    expect((await call("GET", "/auth/login", { headers: edgeOnly })).location).toBe("/signed-out?error=login_failed");
    expect((await call("POST", "/auth/password", { headers: edgeOnly, body: { username: "a", password: "b" } })).data.error).toBe("use_cloudflare");
    expect((await call("POST", "/auth/password", { headers: { "x-unifeye-origin-secret": "wrong" }, body: { username: "a", password: "b" } })).data.error).toBe("use_cloudflare");
    // Replays did not refresh the session's validation time.
    const row = f.sessions.load(s.cookie, false)!;
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 200_000 }).where(eq(schema.sessions.id, row.id)).run();
    await call("GET", "/me", { cookie: s.cookie, jwt: await access(), headers: { "x-unifeye-origin-secret": "wrong" } });
    expect(Date.now() - f.sessions.byId(row.id)!.lastValidatedAt).toBeGreaterThan(190_000);
  });
});

describe("Cloudflare only", () => {
  beforeEach(() => env({ SIGN_IN_METHODS: "cloudflare" }));
  it("a request without the header can't sign in at all", async () => {
    expect((await call("GET", "/auth/login")).location).toBe("/signed-out?error=cloudflare_required");
    expect((await call("POST", "/auth/password", { body: { username: "a", password: "b" } })).status).toBe(404);
  });
  it("work-account sessions from before the switch stop working", async () => {
    const s = f.sessions.create(f.u.front, {});
    expect((await call("GET", "/me", { cookie: s.token })).status).toBe(401);
    expect((await call("GET", "/me", { cookie: s.token, jwt: await access() })).status).toBe(401);
  });
  it("turning Cloudflare off locks its people out", async () => {
    const s = await cfSignIn(await access());
    env({ SIGN_IN_METHODS: "oidc" });
    expect((await call("GET", "/me", { cookie: s.cookie, jwt: await access() })).status).toBe(401);
    expect((await call("GET", "/me", { cookie: s.cookie })).status).toBe(401);
  });
});
