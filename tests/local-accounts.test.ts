import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { hashPassword, LOCAL_ISSUER, passwordProblem, verifyPassword } from "@/server/auth/local";
import { safeReturnTo } from "@/server/auth/oidc";
import { loadConfig, setConfigForTests } from "@/server/config";
import { schema } from "@/server/db";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

let f: Fixture, n = 0, clientIp = "";
const APP = "http://localhost:3000";
const env = (over: Record<string, string> = {}) => setConfigForTests(loadConfig({ ...TEST_ENV, SIGN_IN_METHODS: "oidc,local", ...over } as unknown as NodeJS.ProcessEnv));
const sess = new Map<string, { token: string; csrf: string }>();
function session(userId: string) {
  let t = sess.get(userId);
  if (!t) { const c = f.sessions.create(userId, {}); t = { token: c.token, csrf: c.session.csrfSecret }; sess.set(userId, t); }
  return t;
}
type Opts = { body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string>; preview?: string };
async function call(method: string, path: string, o: Opts = {}) {
  const h: Record<string, string> = { origin: APP, "x-forwarded-for": clientIp, ...o.headers };
  if (o.cookie) h.cookie = `unifeye_session=${o.cookie}`;
  if (o.csrf) h["x-csrf-token"] = o.csrf;
  if (o.preview) h["x-unifeye-preview"] = o.preview;
  if (o.body !== undefined && !("content-type" in h)) h["content-type"] = "application/json";
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  if (body !== undefined && !("content-length" in h)) h["content-length"] = String(Buffer.byteLength(body)); // as a browser sends it
  const res = await handleApi(new Request(`${APP}/api${path}`, { method, headers: h, body }));
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  const cookie = /unifeye_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  return { res, status: res.status, data: text ? JSON.parse(text) : undefined, cookie };
}
const as = (userId: string, method: string, path: string, o: Opts = {}) => { const t = session(userId); return call(method, path, { cookie: t.token, csrf: t.csrf, ...o }); };
const tokenOf = (url: string) => new URL(url).hash.slice(1);
const GOOD = "correct horse battery";

/** Adds a password user through the admin route and returns the one-time link's secret. */
async function addPerson(username = "frontdesk", role = "staff") {
  const r = await as(f.u.admin, "POST", "/admin/users", { body: { name: "Front Desk", username, role } });
  expect(r.status).toBe(200);
  return { id: r.data.id as string, token: tokenOf(r.data.link.url), url: r.data.link.url as string };
}
async function withPassword(username = "frontdesk", password = GOOD) {
  const p = await addPerson(username);
  expect((await call("POST", "/auth/password-link", { body: { token: p.token, password } })).status).toBe(200);
  return p;
}
const signIn = (username: string, password: string, o: Opts = {}) => call("POST", "/auth/password", { body: { username, password }, ...o });

beforeEach(() => {
  sess.clear();
  clientIp = `198.51.100.${++n}`; // the per-address rate limit outlives a test
  f = makeFixture();
  env();
});

describe("password accounts: creation and one-time links", () => {
  it("only administrators add password accounts; the new person has no password, no cameras and is keyed by its own id", async () => {
    expect((await as(f.u.front, "POST", "/admin/users", { body: { name: "X", username: "xx" } })).status).toBe(403);
    const p = await addPerson();
    const u = f.db.select().from(schema.users).where(eq(schema.users.id, p.id)).get()!;
    expect(u).toMatchObject({ issuer: LOCAL_ISSUER, subject: u.id, authMethod: "local", role: "staff", email: null });
    expect(f.db.select().from(schema.localCredentials).where(eq(schema.localCredentials.userId, p.id)).get()).toMatchObject({ username: "frontdesk", passwordHash: null });
    expect(f.policy.cameraIds(p.id).size).toBe(f.policy.cameraIds(f.u.nobody).size); // only what "everyone" gets
    expect(p.url).toMatch(/^http:\/\/localhost:3000\/set-password#/);
    // The link's secret is stored only as a hash and never in the audit log.
    const stored = f.db.select().from(schema.passwordLinks).all();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).not.toBe(p.token);
    expect(JSON.stringify(f.db.select().from(schema.auditLog).all())).not.toContain(p.token);
  });
  it("refuses duplicate and malformed usernames, and is refused during a preview", async () => {
    await addPerson("frontdesk");
    expect((await as(f.u.admin, "POST", "/admin/users", { body: { name: "Again", username: "FrontDesk" } })).status).toBe(409);
    for (const username of ["a", "has space", "<script>", "x".repeat(65), ""]) expect((await as(f.u.admin, "POST", "/admin/users", { body: { name: "X", username } })).status, username).toBe(400);
    const pv = f.previews.start(f.actor(f.u.admin, { sessionId: f.sessions.load(session(f.u.admin).token)!.id }), f.u.front);
    expect((await as(f.u.admin, "POST", "/admin/users", { body: { name: "X", username: "previewer" }, preview: pv.token })).status).toBe(403);
  });
  it("a link shows who it is for, sets the password once, signs the person in, and then stops working", async () => {
    const p = await addPerson();
    expect((await call("POST", "/auth/password-link/check", { body: { token: p.token } })).data).toEqual({ username: "frontdesk", name: "Front Desk", firstTime: true });
    // A weak password is refused without using up the link.
    const weak = await call("POST", "/auth/password-link", { body: { token: p.token, password: "short" } });
    expect(weak.status).toBe(400);
    for (const bad of ["password123", "aaaaaaaaaaaa", "myfrontdesk!!"]) expect((await call("POST", "/auth/password-link", { body: { token: p.token, password: bad } })).status, bad).toBe(400);
    const ok = await call("POST", "/auth/password-link", { body: { token: p.token, password: GOOD } });
    expect(ok.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
    expect((await call("GET", "/me", { cookie: ok.cookie })).data.user).toMatchObject({ id: p.id, signsInWith: "local" });
    const again = await call("POST", "/auth/password-link", { body: { token: p.token, password: "another good phrase" } });
    expect(again.status).toBe(404);
    expect(again.data.error).toBe("link_expired");
    expect((await call("POST", "/auth/password-link/check", { body: { token: p.token } })).status).toBe(404);
  });
  it("an expired link, a made-up link and a superseded link all fail the same way", async () => {
    const p = await addPerson();
    const fresh = await as(f.u.admin, "POST", `/admin/users/${p.id}/password-link`);
    const newer = tokenOf(fresh.data.link.url);
    for (const token of [p.token, "x".repeat(43), "", 42]) {
      const r = await call("POST", "/auth/password-link/check", { body: { token } });
      expect([r.status, r.data.error], String(token)).toEqual([404, "link_expired"]);
    }
    f.db.update(schema.passwordLinks).set({ expiresAt: Date.now() - 1 }).run();
    expect((await call("POST", "/auth/password-link", { body: { token: newer, password: GOOD } })).data.error).toBe("link_expired");
  });
  it("two uses of the same link racing each other: exactly one wins", async () => {
    const p = await addPerson();
    const rs = await Promise.all([1, 2, 3].map((i) => call("POST", "/auth/password-link", { body: { token: p.token, password: `${GOOD} ${i}` } })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 404, 404]);
  });
  it("a new link leaves the current password working until it is used; using it ends every session", async () => {
    const p = await withPassword();
    const first = await signIn("frontdesk", GOOD);
    expect(first.status).toBe(200);
    const link = tokenOf((await as(f.u.admin, "POST", `/admin/users/${p.id}/password-link`)).data.link.url);
    expect((await signIn("frontdesk", GOOD)).status).toBe(200);
    expect((await call("GET", "/me", { cookie: first.cookie })).status).toBe(200);
    expect((await call("POST", "/auth/password-link/check", { body: { token: link } })).data.firstTime).toBe(false);
    expect((await call("POST", "/auth/password-link", { body: { token: link, password: "a brand new phrase" } })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: first.cookie })).status).toBe(401);
    expect((await signIn("frontdesk", GOOD)).status).toBe(401);
    expect((await signIn("frontdesk", "a brand new phrase")).status).toBe(200);
  });
  it("password links are only for password accounts", async () => {
    expect((await as(f.u.admin, "POST", `/admin/users/${f.u.front}/password-link`)).status).toBe(404);
  });
});

describe("password sign-in", () => {
  it("stores only a salted scrypt hash", async () => {
    await withPassword();
    const h = f.db.select().from(schema.localCredentials).get()!.passwordHash!;
    expect(h).toMatch(/^scrypt\$32768\$8\$3\$[\w-]{22}\$[\w-]{43}$/);
    expect(h).not.toContain(GOOD);
    expect(await verifyPassword(GOOD, h)).toBe(true);
    expect(await hashPassword(GOOD)).not.toBe(h);
  });
  it("signs in with the right password, is case-insensitive on the username, and rotates the browser's session", async () => {
    await withPassword();
    const before = session(f.u.front).token;
    const r = await signIn("  FrontDesk ", GOOD, { cookie: before });
    expect(r.status).toBe(200);
    expect(r.data.redirect).toBe("/");
    expect((await call("GET", "/me", { cookie: before })).status).toBe(401);
    expect((await call("POST", "/auth/password", { body: { username: "frontdesk", password: GOOD, returnTo: "//evil.example" } })).data.redirect).toBe("/");
    expect((await call("POST", "/auth/password", { body: { username: "frontdesk", password: GOOD, returnTo: "/activity" } })).data.redirect).toBe("/activity");
  });
  it("a wrong password, an unknown username and an account without a password look the same", async () => {
    await withPassword();
    await addPerson("nopassword");
    const answers = await Promise.all([signIn("frontdesk", "wrong password!"), signIn("nobody-here", GOOD), signIn("nopassword", GOOD), signIn("frontdesk", "")]);
    for (const a of answers) expect([a.status, a.data]).toEqual([401, { error: "wrong_password", message: "That username and password don't match. Try again." }]);
  });
  it("locks a username after repeated failures, whether or not it exists, and the right password waits too", async () => {
    await withPassword();
    for (const name of ["frontdesk", "ghost"]) {
      for (let i = 0; i < 5; i++) expect((await signIn(name, `wrong ${i} attempt`)).status).toBe(401);
      expect((await signIn(name, `wrong 6 attempt`)).data.error).toBe("too_many_tries");
    }
    expect((await signIn("frontdesk", GOOD)).status).toBe(429);
    expect(f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "auth.locked")).all()).toHaveLength(2);
  });
  it("lockout can't be flushed by flooding other usernames", async () => {
    await withPassword();
    for (let i = 0; i < 5; i++) await signIn("frontdesk", `wrong ${i} attempt`);
    // Fill the tracker far past its limit with junk usernames, as an attacker rotating addresses would.
    const fails = (f.s.local as unknown as { fails: Map<string, { n: number; until: number; last: number }> }).fails;
    const t = Date.now();
    for (let i = 0; i < 100_050; i++) fails.set(`junk${i}`, { n: 4, until: 0, last: t });
    expect((await signIn("ghost-user", "anything at all")).status).toBe(401); // triggers eviction
    expect((await signIn("frontdesk", GOOD)).status).toBe(429); // the running lock survived
    expect(fails.size).toBeLessThanOrEqual(100_000);
  });
  it("a fresh username's own count is never evicted mid-count", async () => {
    await withPassword();
    const fails = (f.s.local as unknown as { fails: Map<string, { n: number; until: number; last: number }> }).fails;
    const t = Date.now();
    for (let i = 0; i < 100_050; i++) fails.set(`junk${i}`, { n: 4, until: 0, last: t });
    for (let i = 0; i < 5; i++) expect((await signIn("frontdesk", `wrong ${i} attempt`)).status).toBe(401);
    expect((await signIn("frontdesk", GOOD)).status).toBe(429);
  });
  it("runs two checks at a time, queues twenty, and refuses the rest without counting them", async () => {
    await withPassword();
    const tries = await Promise.all(Array.from({ length: 25 }, (_, i) => signIn(`someone${i}`, GOOD))); // under the 30-a-minute address limit
    // Requests reach the check at slightly different times, so a slot may free up mid-burst.
    const busy = tries.filter((r) => r.data.error === "busy").length, checked = tries.filter((r) => r.data.error === "wrong_password").length;
    expect(busy + checked).toBe(25);
    expect(busy).toBeGreaterThan(0);
    expect(checked).toBeGreaterThanOrEqual(22);
    const fails = (f.s.local as unknown as { fails: Map<string, unknown> }).fails;
    expect(fails.size).toBe(checked); // refused ones were not counted
    expect((await signIn("frontdesk", GOOD)).status).toBe(200);
  });
  it("a disabled person can't sign in, and disabling ends their sessions", async () => {
    const p = await withPassword();
    const s = await signIn("frontdesk", GOOD);
    expect((await as(f.u.admin, "PATCH", `/admin/users/${p.id}`, { body: { status: "disabled" } })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: s.cookie })).status).toBe(401);
    expect((await signIn("frontdesk", GOOD)).data.error).toBe("account_off");
  });
  it("is a browser-only route: needs our Origin and a JSON body", async () => {
    await withPassword();
    expect((await signIn("frontdesk", GOOD, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call("POST", "/auth/password", { body: { username: "frontdesk", password: GOOD }, headers: { origin: "" } })).status).toBe(403);
    expect((await call("POST", "/auth/password", { body: "username=frontdesk&password=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(400);
    expect((await call("POST", "/auth/password", { body: { username: "frontdesk", password: "x".repeat(5000) } })).status).toBe(400);
    expect((await call("POST", "/auth/password", { body: { username: "frontdesk", password: GOOD }, headers: { "content-length": "" } })).status).toBe(400);
    expect((await call("POST", "/auth/password", { body: "[1,2]" })).status).toBe(400);
  });
  it("accepts the local address when LOCAL_APP_URL is set, and links point there", async () => {
    env({ LOCAL_APP_URL: "http://192.168.1.10:3000" });
    const p = await addPerson();
    expect(p.url).toMatch(/^http:\/\/192\.168\.1\.10:3000\/set-password#/);
    expect((await call("POST", "/auth/password-link", { body: { token: p.token, password: GOOD }, headers: { origin: "http://192.168.1.10:3000" } })).status).toBe(200);
    const s = await signIn("frontdesk", GOOD, { headers: { origin: "http://192.168.1.10:3000" } });
    expect(s.status).toBe(200);
  });
  it("logout ends the session and goes to the signed-out page", async () => {
    await withPassword();
    const s = await signIn("frontdesk", GOOD);
    const me = await call("GET", "/me", { cookie: s.cookie });
    const r = await call("POST", "/auth/logout", { cookie: s.cookie, csrf: me.data.csrf });
    expect(r.data.redirect).toBe("/signed-out");
    expect((await call("GET", "/me", { cookie: s.cookie })).status).toBe(401);
  });
});

describe("changing your own password", () => {
  it("needs the current password, keeps this session and ends the others", async () => {
    await withPassword();
    const a = await signIn("frontdesk", GOOD), b = await signIn("frontdesk", GOOD);
    const csrf = (await call("GET", "/me", { cookie: a.cookie })).data.csrf;
    expect((await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: "not it at all", next: "a brand new phrase" } })).status).toBe(400);
    expect((await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: GOOD, next: "short" } })).status).toBe(400);
    expect((await call("POST", "/me/password", { cookie: a.cookie, body: { current: GOOD, next: "a brand new phrase" } })).status).toBe(403); // CSRF still applies
    expect((await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: GOOD, next: "a brand new phrase" } })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: a.cookie })).status).toBe(200);
    expect((await call("GET", "/me", { cookie: b.cookie })).status).toBe(401);
    expect((await signIn("frontdesk", "a brand new phrase")).status).toBe(200);
  });
  it("cancels any unused password link, and wrong guesses here don't lock sign-in", async () => {
    const p = await withPassword();
    const link = tokenOf((await as(f.u.admin, "POST", `/admin/users/${p.id}/password-link`)).data.link.url);
    const a = await signIn("frontdesk", GOOD);
    const csrf = (await call("GET", "/me", { cookie: a.cookie })).data.csrf;
    for (let i = 0; i < 5; i++) await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: `nope ${i} nope`, next: "a brand new phrase" } });
    expect((await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: GOOD, next: "a brand new phrase" } })).data.error).toBe("too_many_tries");
    expect((await signIn("frontdesk", GOOD)).status).toBe(200); // sign-in has its own count
    (f.s.local as unknown as { fails: Map<string, unknown> }).fails.clear(); // as if the lock had run out
    expect((await call("POST", "/me/password", { cookie: a.cookie, csrf, body: { current: GOOD, next: "a brand new phrase" } })).status).toBe(200);
    expect((await call("POST", "/auth/password-link", { body: { token: link, password: "an attacker phrase" } })).data.error).toBe("link_expired");
  });
});

describe("turning sign-in methods off", () => {
  it("passwords off: password people are locked out at once, their sessions stop, and the routes disappear", async () => {
    const p = await withPassword();
    const s = await signIn("frontdesk", GOOD);
    env({ SIGN_IN_METHODS: "oidc" });
    expect((await call("GET", "/me", { cookie: s.cookie })).status).toBe(401);
    expect(f.policy.activeUser(p.id)).toBeUndefined();
    expect(f.policy.cameraIds(p.id).size).toBe(0);
    expect((await signIn("frontdesk", GOOD)).status).toBe(404);
    expect((await as(f.u.front, "GET", "/me")).status).toBe(200); // work accounts are unaffected
    const ov = (await as(f.u.admin, "GET", "/admin/overview")).data;
    expect(ov.users.find((u: { id: string }) => u.id === p.id)).toMatchObject({ signsInWith: "local", methodOn: false });
  });
  it("work accounts off: those people are locked out and only password people remain", async () => {
    const p = await withPassword();
    env({ SIGN_IN_METHODS: "local" });
    expect((await as(f.u.front, "GET", "/me")).status).toBe(401);
    expect(f.policy.isAdmin(f.u.admin)).toBe(false);
    expect((await signIn("frontdesk", GOOD)).status).toBe(200);
    expect(f.policy.activeUser(p.id)).toBeTruthy();
    const login = await call("GET", "/auth/login?returnTo=/activity");
    expect(login.res.headers.get("location")).toBe("/sign-in?returnTo=%2Factivity");
  });
  it("with both on, sign-in goes to the sign-in page, and the work-account button goes to the provider", async () => {
    expect((await call("GET", "/auth/login")).res.headers.get("location")).toBe("/sign-in");
    env({ SIGN_IN_METHODS: "oidc" });
    expect((await call("GET", "/auth/login")).res.headers.get("location")).not.toBe("/sign-in");
  });
});

describe("domains that must use the identity provider", () => {
  const sso = () => env({ OIDC_EMAIL_DOMAINS: "@LittleCampus.ca, example.org", SMTP_URL: "smtp://mail.example", MAIL_FROM: "cams@example.org" });
  it("sends an address at one of them to the provider, whatever its case, and leaves other names alone", async () => {
    sso();
    expect((await call("POST", "/auth/start", { body: { username: " Ana@LittleCampus.CA " } })).data).toEqual({ next: "sso" });
    expect((await call("POST", "/auth/start", { body: { username: "ana@example.org" } })).data).toEqual({ next: "sso" });
    for (const username of ["ana@mail.littlecampus.ca", "ana@littlecampus.ca.evil", "littlecampus.ca", "frontdesk"])
      expect((await call("POST", "/auth/start", { body: { username } })).data, username).toEqual({ next: "password" });
  });
  it("refuses password and code sign-in for them, even for an account made before the setting", async () => {
    const p = await withPassword("ana@littlecampus.ca");
    expect((await signIn("ana@littlecampus.ca", GOOD)).status).toBe(200);
    sso();
    const r = await signIn("Ana@littlecampus.ca", GOOD);
    expect(r.status).toBe(403);
    expect(r.data).toMatchObject({ error: "use_sso", message: "Sign in with SSO instead." });
    expect((await call("POST", "/auth/email", { body: { username: "ana@littlecampus.ca" } })).status).toBe(403);
    const link = tokenOf((await as(f.u.admin, "POST", `/admin/users/${p.id}/password-link`)).data.link.url);
    expect((await call("POST", "/auth/password-link/check", { body: { token: link } })).status).toBe(403);
    expect((await call("POST", "/auth/password-link", { body: { token: link, password: "another good phrase" } })).status).toBe(403);
    expect((await signIn("frontdesk", GOOD)).status).toBe(401); // other names are unaffected
  });
  it("administrators can't add password accounts at them", async () => {
    sso();
    const r = await as(f.u.admin, "POST", "/admin/users", { body: { name: "Ana", username: "ana@littlecampus.ca" } });
    expect(r.status).toBe(400);
    expect(r.data.message).toMatch(/littlecampus\.ca sign in with SSO/);
    expect((await as(f.u.admin, "POST", "/admin/users", { body: { name: "Ana", username: "ana@gmail.com" } })).status).toBe(200);
  });
  it("needs both the provider and passwords on, and real domains", () => {
    const load = (o: Record<string, string>) => () => loadConfig({ ...TEST_ENV, ...o } as unknown as NodeJS.ProcessEnv);
    expect(load({ SIGN_IN_METHODS: "oidc", OIDC_EMAIL_DOMAINS: "littlecampus.ca" })).toThrowError(/both oidc and local/);
    expect(load({ SIGN_IN_METHODS: "local", OIDC_EMAIL_DOMAINS: "littlecampus.ca" })).toThrowError(/both oidc and local/);
    expect(load({ SIGN_IN_METHODS: "oidc,local", OIDC_EMAIL_DOMAINS: "not a domain" })).toThrowError(/like example\.com/);
    expect(load({ SIGN_IN_METHODS: "oidc,local", OIDC_EMAIL_DOMAINS: "@LittleCampus.ca" })().OIDC_EMAIL_DOMAINS).toEqual(["littlecampus.ca"]);
  });
});

describe("return addresses", () => {
  it("never leave the site, including through characters URL parsers strip", () => {
    for (const bad of ["/\u4e2d", "/caf\u00e9", "/\t/evil.example", "/\r/evil.example", "/\n/evil.example", "/ /evil.example", "//evil.example", "/\\evil.example", "https://evil.example", "/api/auth/logout", "/\u0000x"])
      expect(safeReturnTo(bad), JSON.stringify(bad)).toBe("/");
    expect(safeReturnTo("/view/abc?all")).toBe("/view/abc?all");
  });
});

describe("password rules", () => {
  it("are about length and guessability, not character classes", () => {
    expect(passwordProblem("short", "u")).toMatch(/10/);
    expect(passwordProblem("x".repeat(201), "u")).toMatch(/200/);
    expect(passwordProblem("Password123", "u")).toMatch(/guess/);
    expect(passwordProblem("hello frontdesk", "frontdesk")).toMatch(/username/);
    expect(passwordProblem("purple monkey dishwasher", "frontdesk")).toBeNull();
    expect(passwordProblem(12345678901, "u")).toMatch(/10/);
  });
});

describe("configuration guards", () => {
  const secret = "a".repeat(32);
  const prod = { NODE_ENV: "production", APP_URL: "https://cams.example", MEDIAMTX_HOOK_SECRET: secret, MEDIAMTX_API_SECRET: secret } as Record<string, string>;
  const load = (o: Record<string, string>) => () => loadConfig(o as unknown as NodeJS.ProcessEnv);
  it("passwords only need no identity provider settings, even in production", () => {
    expect(load({ ...prod, SIGN_IN_METHODS: "local" })).not.toThrow();
    expect(load({ ...prod, SIGN_IN_METHODS: "oidc,local" })).toThrowError(/OIDC_ISSUER is required/);
  });
  it("rejects unknown methods, an empty list, oidc with cloudflare, and incomplete Cloudflare settings", () => {
    expect(load({ ...prod, SIGN_IN_METHODS: "local,ldap" })).toThrow();
    expect(load({ ...prod, SIGN_IN_METHODS: " , " })).toThrow();
    expect(load({ ...TEST_ENV, SIGN_IN_METHODS: "oidc,cloudflare", CF_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", CF_ACCESS_AUD: "x" } as Record<string, string>)).toThrowError(/cannot combine/);
    expect(load({ ...prod, SIGN_IN_METHODS: "cloudflare" })).toThrowError(/CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/);
    expect(load({ ...prod, SIGN_IN_METHODS: "cloudflare", CF_ACCESS_TEAM_DOMAIN: "evil.example.com", CF_ACCESS_AUD: "x" })).toThrowError(/cloudflareaccess\.com/);
    expect(load({ ...prod, SIGN_IN_METHODS: "cloudflare", CF_ACCESS_TEAM_DOMAIN: "https://Acme.cloudflareaccess.com/", CF_ACCESS_AUD: "x" })().CF_ACCESS_TEAM_DOMAIN).toBe("acme.cloudflareaccess.com");
  });
  it("Cloudflare with passwords needs the origin secret; the re-check is capped at an hour", () => {
    const cf = { ...prod, CF_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com", CF_ACCESS_AUD: "x" };
    expect(load({ ...cf, SIGN_IN_METHODS: "cloudflare,local" })).toThrowError(/CF_ACCESS_ORIGIN_SECRET is required/);
    expect(load({ ...cf, SIGN_IN_METHODS: "cloudflare,local", CF_ACCESS_ORIGIN_SECRET: "short" })).toThrowError(/at least 32/);
    expect(load({ ...cf, SIGN_IN_METHODS: "cloudflare,local", CF_ACCESS_ORIGIN_SECRET: "s".repeat(32) })).not.toThrow();
    expect(load({ ...cf, SIGN_IN_METHODS: "cloudflare" })).not.toThrow();
    expect(load({ ...cf, SIGN_IN_METHODS: "cloudflare", CF_ACCESS_RECHECK_SECONDS: "7200" })).toThrowError(/3600/);
  });
  it("LOCAL_APP_URL needs passwords, a different address, and https in production", () => {
    expect(load({ ...prod, SIGN_IN_METHODS: "local", LOCAL_APP_URL: "http://192.168.1.10" })).toThrowError(/LOCAL_APP_URL must use https/);
    expect(load({ ...prod, SIGN_IN_METHODS: "local", LOCAL_APP_URL: "https://cams.example/" })).toThrowError(/different address/);
    expect(load({ ...TEST_ENV, LOCAL_APP_URL: "http://192.168.1.10" } as Record<string, string>)).toThrowError(/needs SIGN_IN_METHODS/);
    expect(load({ ...prod, SIGN_IN_METHODS: "local", LOCAL_APP_URL: "https://cams.lan" })).not.toThrow();
  });
});
