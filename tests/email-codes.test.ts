import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { codeEmail, describeDevice } from "@/server/auth/local";
import { emailCodesOn, loadConfig, setConfigForTests } from "@/server/config";
import { schema } from "@/server/db";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

let f: Fixture, n = 0, clientIp = "";
const APP = "http://localhost:3000";
const MAIL = { SMTP_URL: "smtp://mail.test:2525", MAIL_FROM: "Unifeye <cameras@example.test>" };
const env = (over: Record<string, string> = {}) => setConfigForTests(loadConfig({ ...TEST_ENV, SIGN_IN_METHODS: "oidc,local", ...MAIL, ...over } as unknown as NodeJS.ProcessEnv));
const sess = new Map<string, { token: string; csrf: string }>();
function session(userId: string) {
  let t = sess.get(userId);
  if (!t) { const c = f.sessions.create(userId, {}); t = { token: c.token, csrf: c.session.csrfSecret }; sess.set(userId, t); }
  return t;
}
type Opts = { body?: unknown; cookies?: Record<string, string>; csrf?: string; headers?: Record<string, string> };
async function call(method: string, path: string, o: Opts = {}) {
  const h: Record<string, string> = { origin: APP, "x-forwarded-for": clientIp, "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36", ...o.headers };
  if (o.cookies) h.cookie = Object.entries(o.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  if (o.csrf) h["x-csrf-token"] = o.csrf;
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  if (body !== undefined) { h["content-type"] = "application/json"; h["content-length"] = String(Buffer.byteLength(body)); }
  const res = await handleApi(new Request(`${APP}/api${path}`, { method, headers: h, body }));
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  const set = res.headers.getSetCookie();
  const cookie = (name: string) => set.map((c) => new RegExp(`^${name}=([^;]*)`).exec(c)?.[1]).find((x) => x !== undefined);
  return { res, status: res.status, data: text ? JSON.parse(text) : undefined, set, session: cookie("unifeye_session"), secret: cookie("unifeye_email_code") };
}
const as = (userId: string, method: string, path: string, o: Opts = {}) => { const t = session(userId); return call(method, path, { cookies: { unifeye_session: t.token }, csrf: t.csrf, ...o }); };
const askCode = (username: string, o: Opts = {}) => call("POST", "/auth/email", { body: { username, timeZone: "America/Toronto" }, ...o });
const enterCode = (secret: string | undefined, code: string) => call("POST", "/auth/email/verify", { body: { code, returnTo: "/views" }, cookies: secret ? { unifeye_email_code: secret } : {} });
const codeIn = (i = -1) => /^\s+(\d{3}) (\d{3})$/m.exec(f.mailer.sent.at(i)!.text)!.slice(1).join("");

async function addPerson(username: string, body: Record<string, unknown>) {
  const r = await as(f.u.admin, "POST", "/admin/users", { body: { name: username === "office" ? "Office" : username, username, ...body } });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return { id: r.data.id as string, link: r.data.link as { url: string } | null };
}
const office = () => addPerson("office", { password: false, codeEmails: ["Manager@Example.com", "backup@example.com"] });

beforeEach(() => {
  sess.clear();
  clientIp = `203.0.113.${++n}`;
  f = makeFixture();
  env();
});

describe("email codes: setting up accounts", () => {
  it("an account with email codes only gets no password link and has no password", async () => {
    const p = await office();
    expect(p.link).toBeNull();
    expect(f.db.select().from(schema.localCredentials).where(eq(schema.localCredentials.userId, p.id)).get()).toMatchObject({ passwordAllowed: false, passwordHash: null, codeEmails: ["manager@example.com", "backup@example.com"] });
    expect(f.db.select().from(schema.passwordLinks).all()).toHaveLength(0);
    expect((await as(f.u.admin, "POST", `/admin/users/${p.id}/password-link`)).status).toBe(400);
  });
  it("needs at least one way in, valid addresses (at most three), and outgoing mail for codes", async () => {
    for (const body of [{ password: false, codeEmails: [] }, { codeEmails: ["not-an-email"] }, { codeEmails: ["a@x.test", "b@x.test", "c@x.test", "d@x.test"] }])
      expect((await as(f.u.admin, "POST", "/admin/users", { body: { name: "X", username: "xx", ...body } })).status, JSON.stringify(body)).toBe(400);
    env({ SMTP_URL: "", MAIL_FROM: "" });
    const r = await as(f.u.admin, "POST", "/admin/users", { body: { name: "X", username: "xx", codeEmails: ["a@x.test"] } });
    expect(r.status).toBe(400);
    expect(r.data.message).toBe("Email isn't set up on the server yet.");
  });
  it("only administrators change how someone signs in", async () => {
    const p = await office();
    expect((await as(f.u.front, "PUT", `/admin/users/${p.id}/sign-in`, { body: { password: true } })).status).toBe(403);
  });
  it("SMTP_URL and MAIL_FROM go together; without password accounts email codes stay off", () => {
    expect(() => loadConfig({ ...TEST_ENV, SIGN_IN_METHODS: "oidc,local", SMTP_URL: MAIL.SMTP_URL } as unknown as NodeJS.ProcessEnv)).toThrow(/together/);
    const noLocal = loadConfig({ ...TEST_ENV, SIGN_IN_METHODS: "oidc", ...MAIL } as unknown as NodeJS.ProcessEnv);
    expect(noLocal.SMTP_URL).toBe(MAIL.SMTP_URL);
    expect(emailCodesOn(noLocal)).toBe(false);
    expect(() => loadConfig({ ...TEST_ENV, SIGN_IN_METHODS: "oidc,local", ...MAIL, SMTP_URL: "http://x" } as unknown as NodeJS.ProcessEnv)).toThrow(/smtp/);
  });
});

describe("email codes: signing in", () => {
  it("emails a code to every address, which signs in only the browser that asked, once", async () => {
    const p = await office();
    const a = await askCode("OFFICE");
    expect(a.status).toBe(200);
    expect(a.secret).toBeTruthy();
    expect(a.set.find((c) => c.startsWith("unifeye_email_code="))).toMatch(/Path=\/api\/auth; HttpOnly; SameSite=Strict; Max-Age=600/);
    expect(f.mailer.sent).toHaveLength(1);
    const m = f.mailer.sent[0];
    expect(m.to).toEqual(["manager@example.com", "backup@example.com"]);
    expect(m.subject).toBe("Sign-in code for Office");
    expect(m.text).toContain("Chrome on Windows");
    const code = codeIn();
    expect(m.subject).not.toContain(code.slice(0, 3));
    // Stored rows don't reveal the code or the browser's secret.
    expect(JSON.stringify(f.db.select().from(schema.emailCodes).all())).not.toContain(a.secret);

    // Another browser can't use the code.
    const other = await askCode("someone-else");
    expect((await enterCode(other.secret, code)).status).toBe(400);
    expect((await enterCode(undefined, code)).data.error).toBe("code_expired");

    const ok = await enterCode(a.secret, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(ok.status).toBe(200);
    expect(ok.data.redirect).toBe("/views");
    expect(ok.session).toBeTruthy();
    expect(ok.set.some((c) => /^unifeye_email_code=;.*Max-Age=0/.test(c))).toBe(true);
    expect(f.sessions.load(ok.session)!.userId).toBe(p.id);
    const login = f.db.select().from(schema.auditLog).all().find((x) => x.action === "auth.login" && x.outcome === "ok" && x.actorId === p.id);
    expect(login?.detail).toMatchObject({ method: "local", via: "email" });

    expect((await enterCode(a.secret, code)).data.error).toBe("code_expired");
  });

  it("answers the same for unknown, password-only, disabled and code accounts, and only emails the last", async () => {
    const p = await office();
    await addPerson("frontdesk", {});
    const disabled = await addPerson("gone", { codeEmails: ["gone@example.com"] });
    await as(f.u.admin, "PATCH", `/admin/users/${disabled.id}`, { body: { status: "disabled" } });
    const answers = [];
    for (const u of ["nobody-here", "frontdesk", "gone", "office", "<bad name>"]) {
      const r = await askCode(u);
      answers.push({ status: r.status, data: r.data, hasSecret: !!r.secret });
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(f.mailer.sent.map((m) => m.to)).toEqual([["manager@example.com", "backup@example.com"]]);
    expect(f.db.select().from(schema.emailCodes).all().filter((r) => r.userId === p.id)).toHaveLength(1);
  });

  it("five wrong codes end the request, counted the same whether or not the account exists", async () => {
    await office();
    for (const u of ["office", "nobody-here"]) {
      const a = await askCode(u);
      const results = [];
      for (let i = 0; i < 6; i++) results.push((await enterCode(a.secret, "000000")).data.error);
      // A 1 in a million chance the real code is 000000; the shape is what matters.
      expect(results.slice(0, 4).every((e) => e === "wrong_code"), u).toBe(true);
      expect(results.slice(4), u).toEqual(["too_many_tries", "too_many_tries"]);
    }
    const right = codeIn();
    const fresh = f.db.select().from(schema.emailCodes).all();
    expect(fresh.every((r) => r.tries === 5)).toBe(true);
    expect(right).toMatch(/^\d{6}$/);
  });

  it("limits how often codes can be sent, for real and unknown usernames alike", async () => {
    await office();
    for (const u of ["office", "nobody-here"]) {
      expect((await askCode(u)).status).toBe(200);
      const again = await askCode(u);
      expect(again.status).toBe(429);
      expect(again.data.message).toBe("Wait a minute before asking for another code.");
      expect(again.secret).toBeUndefined();
    }
    expect(f.mailer.sent).toHaveLength(1);
  });

  it("asking again replaces the earlier code", async () => {
    const p = await office();
    const first = await askCode("office"), firstCode = codeIn();
    f.s.local["sends"].clear(); // skip the one-minute wait
    const second = await askCode("office");
    expect((await enterCode(first.secret, firstCode)).data.error).toBe("code_expired");
    expect((await enterCode(second.secret, codeIn())).status).toBe(200);
    expect(f.db.select().from(schema.emailCodes).all().filter((r) => r.userId === p.id)).toHaveLength(1);
  });

  it("an expired code no longer works", async () => {
    await office();
    const a = await askCode("office");
    f.db.update(schema.emailCodes).set({ expiresAt: Date.now() - 1 }).run();
    expect((await enterCode(a.secret, codeIn())).data.error).toBe("code_expired");
  });

  it("a code for an account turned off meanwhile says so instead of signing in", async () => {
    const p = await office();
    const a = await askCode("office");
    await as(f.u.admin, "PATCH", `/admin/users/${p.id}`, { body: { status: "disabled" } });
    const r = await enterCode(a.secret, codeIn());
    expect(r.status).toBe(403);
    expect(r.session).toBeUndefined();
  });

  it("a failed email is recorded and shown to administrators, but the answer doesn't change", async () => {
    await office();
    f.mailer.fail = true;
    const r = await askCode("office");
    expect(r.status).toBe(200);
    await new Promise((res) => setTimeout(res, 0));
    expect(f.db.select().from(schema.auditLog).all().some((x) => x.action === "auth.code_sent" && x.outcome === "error")).toBe(true);
    expect((await as(f.u.admin, "GET", "/admin/overview")).data.mail).toEqual({ failing: true });
  });

  it("the routes don't exist without outgoing mail, and need Unifeye's own origin", async () => {
    await office();
    expect((await askCode("office", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    env({ SMTP_URL: "", MAIL_FROM: "" });
    expect((await askCode("office")).status).toBe(404);
    expect((await enterCode("x".repeat(43), "123456")).status).toBe(404);
  });
});

const start = (username: string, o: Opts = {}) => call("POST", "/auth/start", { body: { username, timeZone: "America/Toronto" }, ...o });

describe("two-step sign-in: what comes after the username", () => {
  it("only code-only accounts go to a code; every other username gets the same password step", async () => {
    await office();
    await addPerson("frontdesk", {});
    await addPerson("both", { codeEmails: ["both@example.com"] });
    const off = await addPerson("gone", {});
    await as(f.u.admin, "PATCH", `/admin/users/${off.id}`, { body: { status: "disabled" } });
    const answers = [];
    for (const u of ["frontdesk", "both", "gone", "nobody-here", "<bad name>"]) {
      const r = await start(u);
      answers.push({ status: r.status, data: r.data, secret: r.secret });
    }
    expect(answers.every((a) => JSON.stringify(a) === JSON.stringify({ status: 200, data: { next: "password" } }))).toBe(true);
    expect(f.mailer.sent).toHaveLength(0);

    const r = await start("Office");
    expect(r.data).toEqual({ next: "code" });
    expect(r.secret).toBeTruthy();
    expect(f.mailer.sent).toHaveLength(1);
    expect((await enterCode(r.secret, codeIn())).status).toBe(200);
  });

  it("going back and continuing again in the same browser reuses the code instead of sending another", async () => {
    await office();
    const first = await start("office");
    const again = await start("office", { cookies: { unifeye_email_code: first.secret! } });
    expect(again.data).toEqual({ next: "code" });
    expect(again.secret).toBeUndefined();
    expect(f.mailer.sent).toHaveLength(1);
    expect((await enterCode(first.secret, codeIn())).status).toBe(200);
    // Another browser within the minute is asked to wait.
    expect((await start("office")).status).toBe(429);
  });

  it("without outgoing mail every username gets the password step", async () => {
    await office();
    env({ SMTP_URL: "", MAIL_FROM: "" });
    expect((await start("office")).data).toEqual({ next: "password" });
    expect(f.mailer.sent).toHaveLength(0);
  });

  it("needs Unifeye's own origin and password accounts turned on", async () => {
    expect((await start("office", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    env({ SIGN_IN_METHODS: "oidc", SMTP_URL: "", MAIL_FROM: "" });
    expect((await start("office")).status).toBe(404);
  });
});

describe("email codes: changing how someone signs in", () => {
  it("turning the password off removes it, cancels links, signs them out and stops password sign-in", async () => {
    const p = await addPerson("frontdesk", { codeEmails: ["fd@example.com"] });
    const token = new URL(p.link!.url).hash.slice(1);
    expect((await call("POST", "/auth/password-link", { body: { token, password: "correct horse battery" } })).status).toBe(200);
    const before = await call("POST", "/auth/password", { body: { username: "frontdesk", password: "correct horse battery" } });
    expect(before.status).toBe(200);
    expect((await call("GET", "/me", { cookies: { unifeye_session: before.session! } })).data.user.hasPassword).toBe(true);

    const r = await as(f.u.admin, "PUT", `/admin/users/${p.id}/sign-in`, { body: { password: false, codeEmails: ["fd@example.com"] } });
    expect(r.status).toBe(200);
    expect(f.db.select().from(schema.localCredentials).where(eq(schema.localCredentials.userId, p.id)).get()).toMatchObject({ passwordAllowed: false, passwordHash: null });
    expect(f.sessions.load(before.session)).toBeFalsy();
    const after = await call("POST", "/auth/password", { body: { username: "frontdesk", password: "correct horse battery" } });
    expect(after.status).toBe(401);
    expect(after.data.error).toBe("wrong_password");
  });

  it("removing an address cancels pending codes and signs them out; adding one doesn't", async () => {
    const p = await office();
    const a = await askCode("office"), code = codeIn();
    const s1 = f.sessions.create(p.id, {});
    expect((await as(f.u.admin, "PUT", `/admin/users/${p.id}/sign-in`, { body: { password: false, codeEmails: ["manager@example.com", "backup@example.com", "third@example.com"] } })).status).toBe(200);
    expect(f.sessions.load(s1.token)).toBeTruthy();
    expect((await enterCode(a.secret, code)).data.error).toBe("code_expired"); // any change cancels pending codes
    expect((await as(f.u.admin, "PUT", `/admin/users/${p.id}/sign-in`, { body: { password: false, codeEmails: ["manager@example.com"] } })).status).toBe(200);
    expect(f.sessions.load(s1.token)).toBeFalsy();
  });

  it("turning the password on returns a link to choose one", async () => {
    const p = await office();
    const r = await as(f.u.admin, "PUT", `/admin/users/${p.id}/sign-in`, { body: { password: true, codeEmails: ["manager@example.com"] } });
    expect(r.data.link.url).toMatch(/\/set-password#/);
  });

  it("someone signed in with a code can't set a password themselves", async () => {
    const p = await office();
    await askCode("office");
    const a = f.db.select().from(schema.emailCodes).all()[0];
    expect(a.userId).toBe(p.id);
    const s = f.sessions.create(p.id, {});
    const me = await call("GET", "/me", { cookies: { unifeye_session: s.token } });
    expect(me.data.user.hasPassword).toBe(false);
    const r = await call("POST", "/me/password", { cookies: { unifeye_session: s.token }, csrf: s.session.csrfSecret, body: { current: "", next: "a brand new password" } });
    expect(r.status).toBe(404);
  });
});

describe("email codes: the email itself", () => {
  it("describes the device and keeps the code out of the subject", () => {
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/133.0")).toBe("Firefox on Mac");
    expect(describeDevice("")).toBe("A web browser");
    const m = codeEmail({ name: "Office", code: "482913", device: "Chrome on Windows", when: "Nov 18, 2026, 9:02 AM" });
    expect(m.subject).toBe("Sign-in code for Office");
    expect(m.text).toContain("482 913");
    expect(m.text).toContain("It works for 10 minutes.");
  });
});
