import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { loadConfig, setConfigForTests } from "@/server/config";
import { schema } from "@/server/db";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";
import { Oidc } from "@/server/auth/oidc";

/**
 * An isolated test identity provider (discovery, JWKS, token endpoint). It exists only in this
 * test file; the application has no switch that could enable a test login in production.
 */
type KP = Awaited<ReturnType<typeof generateKeyPair>>;
let server: Server, issuer = "", good: KP, evil: KP, jwk: JWK;
const idp = { claims: {} as Record<string, unknown>, signWith: undefined as KP | undefined, refreshIdClaims: undefined as Record<string, unknown> | undefined, refreshOk: true, down: false, refreshCalls: 0, pkce: "" };
const CLIENT = "vantage-test";

async function idToken(extra: Record<string, unknown>, key: KP = good) {
  return new SignJWT({ ...extra }).setProtectedHeader({ alg: "RS256", kid: "k1" }).sign(key.privateKey);
}
beforeAll(async () => {
  good = await generateKeyPair("RS256"); evil = await generateKeyPair("RS256");
  jwk = { ...(await exportJWK(good.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (idp.down) return void req.socket.destroy();
    if (req.url === "/.well-known/openid-configuration") return send(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/keys`, end_session_endpoint: `${issuer}/end_session`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"], code_challenge_methods_supported: ["S256"], backchannel_logout_supported: true });
    if (req.url === "/keys") return send(200, { keys: [jwk] });
    if (req.url === "/token") {
      let body = ""; for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      if (p.get("grant_type") === "refresh_token") {
        idp.refreshCalls++;
        if (!idp.refreshOk) return send(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const id_token = idp.refreshIdClaims && await idToken({ iss: issuer, aud: CLIENT, iat: now, exp: now + 300, ...idp.refreshIdClaims }, idp.signWith ?? good);
        return send(200, { access_token: "at2", token_type: "Bearer", refresh_token: "rt-rotated", ...(id_token ? { id_token } : {}) });
      }
      idp.pkce = p.get("code_verifier") ?? "";
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: CLIENT, iat: now, exp: now + 300, sid: "sid-1", ...idp.claims };
      return send(200, { access_token: "at", token_type: "Bearer", refresh_token: "rt", id_token: await idToken(claims, idp.signWith ?? good) });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let f: Fixture, oidc: Oidc;
const env = (over: Record<string, string> = {}) => loadConfig({ ...TEST_ENV, OIDC_ISSUER: issuer, OIDC_ALLOW_INSECURE_ISSUER: "1", APP_URL: "http://localhost:3000", ...over } as unknown as NodeJS.ProcessEnv);
beforeEach(() => {
  f = makeFixture();
  setConfigForTests(env());
  oidc = new Oidc(f.db, f.policy, f.sessions);
  Object.assign(idp, { claims: {}, signWith: undefined, refreshIdClaims: undefined, refreshOk: true, down: false, refreshCalls: 0 });
});

/** Runs the redirect half of the flow and returns what the browser would bring back. */
async function begin() {
  const b = await oidc.begin("/views");
  const u = new URL(b.url);
  return { cookie: b.cookie, state: u.searchParams.get("state")!, nonce: u.searchParams.get("nonce")!, url: u };
}
const cb = (state: string, code = "c1") => new URL(`http://localhost:3000/api/auth/callback?code=${code}&state=${state}`);
async function login(claims: Record<string, unknown>) {
  const b = await begin();
  idp.claims = { nonce: b.nonce, groups: ["vantage"], ...claims };
  return oidc.complete(cb(b.state), b.cookie, { ip: "198.51.100.7" });
}
const reason = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { reason?: string }).reason ?? String(e));

describe("OIDC login", () => {
  it("uses Authorization Code with PKCE S256, state and nonce, and only the configured scopes", async () => {
    const b = await begin();
    expect(b.url.origin + b.url.pathname).toBe(`${issuer}/authorize`);
    expect(b.url.searchParams.get("response_type")).toBe("code");
    expect(b.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(b.url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(b.url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/callback");
    expect(b.url.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(b.state.length).toBeGreaterThan(20); expect(b.nonce.length).toBeGreaterThan(20);
  });
  it("adds configured extra parameters to the sign-in request but never lets them replace protocol ones", async () => {
    setConfigForTests(env({ OIDC_AUTH_PARAMS: "access_type=offline&prompt=consent" }));
    oidc = new Oidc(f.db, f.policy, f.sessions);
    const b = await begin();
    expect(b.url.searchParams.get("access_type")).toBe("offline");
    expect(b.url.searchParams.get("prompt")).toBe("consent");
    expect(b.url.searchParams.get("code_challenge_method")).toBe("S256");
    for (const k of ["redirect_uri", "state", "nonce", "code_challenge_method", "scope"])
      expect(() => env({ OIDC_AUTH_PARAMS: `${k}=x` })).toThrowError(new RegExp(`cannot set ${k}`));
  });
  it("provisions a first-time user with zero access, keyed by issuer + subject", async () => {
    const r = await login({ sub: "new-1", name: "Nia New", email: "nia@example.test" });
    expect(idp.pkce).toMatch(/^[\w-]{43,}$/); // the verifier went to the token endpoint, server to server
    expect(r.returnTo).toBe("/views");
    expect(r.user).toMatchObject({ issuer, subject: "new-1", role: "staff" });
    expect(f.names(r.user.id)).toEqual([]);
    expect(f.policy.groupIds(r.user.id)).toEqual([f.g["All Staff"]]);
    expect(f.sessions.load(r.token)?.providerSid).toBe("sid-1");
    const again = await login({ sub: "new-1", name: "Nia Renamed", email: "other@example.test" });
    expect(again.user.id).toBe(r.user.id); // same subject, changed email: same profile
  });
  it("never links by email: the same email under another subject is a different, empty profile", async () => {
    f.db.update(schema.users).set({ issuer }).run();
    const r = await login({ sub: "impostor", email: "admin@example.test", name: "Avery Chen" });
    expect(r.user.id).not.toBe(f.u.admin);
    expect(r.user.role).toBe("staff");
    expect(f.names(r.user.id)).toEqual([]);
  });
  it("rejects a replayed callback, an unknown transaction and a wrong state", async () => {
    const b = await begin();
    idp.claims = { nonce: b.nonce, sub: "s", groups: ["vantage"] };
    await oidc.complete(cb(b.state), b.cookie, {});
    expect(await reason(oidc.complete(cb(b.state), b.cookie, {}))).toBe("transaction_replayed_or_unknown");
    expect(await reason(oidc.complete(cb(b.state), "not-a-cookie", {}))).toBe("transaction_replayed_or_unknown");
    expect(await reason(oidc.complete(cb(b.state), undefined, {}))).toBe("no_transaction");
    const c = await begin();
    expect(await reason(oidc.complete(cb("attacker-state"), c.cookie, {}))).toBe("token_validation_failed");
  });
  it("rejects a nonce mismatch, wrong issuer, wrong audience, bad signature and an expired token", async () => {
    const now = Math.floor(Date.now() / 1000), base = { sub: "s", groups: ["vantage"] };
    const attempt = async (claims: (nonce: string) => Record<string, unknown>, key?: KP) => { const b = await begin(); idp.claims = claims(b.nonce); idp.signWith = key; const r = await reason(oidc.complete(cb(b.state), b.cookie, {})); idp.signWith = undefined; return r; };
    expect(await attempt(() => ({ ...base, nonce: "someone-elses" }))).toBe("token_validation_failed");
    expect(await attempt((n) => ({ ...base, nonce: n, iss: "https://evil.example" }))).toBe("token_validation_failed");
    expect(await attempt((n) => ({ ...base, nonce: n, aud: "another-client" }))).toBe("token_validation_failed");
    expect(await attempt((n) => ({ ...base, nonce: n }), evil)).toBe("token_validation_failed");
    expect(await attempt((n) => ({ ...base, nonce: n, iat: now - 7200, exp: now - 3600 }))).toBe("token_validation_failed");
    expect(await attempt((n) => ({ ...base, nonce: n }))).toBe("ok");
    expect(f.db.select().from(schema.auditLog).all().filter((r) => r.action === "auth.login" && r.outcome === "denied").length).toBe(5);
  });
  it("admits only users whose admission claim carries an accepted value", async () => {
    expect(await reason(login({ sub: "x", groups: ["other"] }))).toBe("not_admitted");
    expect(await reason(login({ sub: "x", groups: undefined }))).toBe("not_admitted");
    expect(await reason(login({ sub: "x", groups: "vantage-ish" }))).toBe("not_admitted");
    expect(f.db.select().from(schema.users).all().some((u) => u.subject === "x")).toBe(false); // nothing provisioned
    expect(await reason(login({ sub: "y", groups: "vantage" }))).toBe("ok"); // a single string value
    expect(await reason(login({ sub: "y", groups: ["a", "vantage"] }))).toBe("ok");
  });
  it("reads object-shaped and nested claims, and can require presence only", async () => {
    const use = (over: Record<string, string>) => { setConfigForTests(env(over)); oidc = new Oidc(f.db, f.policy, f.sessions); };
    use({ OIDC_ADMIT_CLAIM: "roles", OIDC_ADMIT_VALUES: "viewer" });
    expect(await reason(login({ sub: "o", roles: { viewer: { "org-1": "x" } } }))).toBe("ok"); // keys are the values
    expect(await reason(login({ sub: "o", roles: { editor: {} } }))).toBe("not_admitted");
    use({ OIDC_ADMIT_CLAIM: "realm_access.roles", OIDC_ADMIT_VALUES: "vantage" });
    expect(await reason(login({ sub: "n", realm_access: { roles: ["vantage"] } }))).toBe("ok");
    expect(await reason(login({ sub: "n", realm_access: { roles: ["other"] } }))).toBe("not_admitted");
    use({ OIDC_ADMIT_CLAIM: "https://example.test/roles", OIDC_ADMIT_VALUES: "" });
    expect(await reason(login({ sub: "p", "https://example.test/roles": ["anything"] }))).toBe("ok"); // exact name with dots
    expect(await reason(login({ sub: "p", "https://example.test/roles": [] }))).toBe("not_admitted");
    use({ OIDC_ADMIT_CLAIM: "", OIDC_ADMIT_VALUES: "" });
    expect(await reason(login({ sub: "q", groups: undefined }))).toBe("ok"); // no rule configured (development)
  });
  it("bootstraps the first administrator once, by exact issuer and subject only", async () => {
    setConfigForTests(env({ BOOTSTRAP_ADMIN_ISSUER: issuer, BOOTSTRAP_ADMIN_SUBJECT: "boot-1" }));
    oidc = new Oidc(f.db, f.policy, f.sessions);
    expect((await login({ sub: "someone-first", email: "boot@example.test" })).user.role).toBe("staff"); // first to log in gets nothing
    expect((await login({ sub: "boot-1", email: "boot@example.test" })).user.role).toBe("admin");
    expect(f.db.select().from(schema.auditLog).all().filter((r) => r.action === "admin.bootstrap")).toHaveLength(1);
    // Bootstrap is spent: demoting and signing in again does not re-promote.
    const u = f.db.select().from(schema.users).all().find((x) => x.subject === "boot-1")!;
    f.db.update(schema.users).set({ role: "staff" }).run();
    f.policy.invalidate();
    expect((await login({ sub: "boot-1" })).user.id).toBe(u.id);
    expect(f.policy.user(u.id)!.role).toBe("staff");
  });
  it("refuses a disabled account and rotates the session on every sign-in", async () => {
    const first = await login({ sub: "rot" });
    const b = await begin();
    idp.claims = { nonce: b.nonce, sub: "rot", groups: ["vantage"] };
    const second = await oidc.complete(cb(b.state), b.cookie, { previousSessionToken: first.token });
    expect(second.token).not.toBe(first.token);
    expect(f.sessions.load(first.token)).toBeUndefined();
    f.admin.updateUser(f.actor(f.u.admin), first.user.id, { status: "disabled" });
    expect(f.sessions.load(second.token)).toBeUndefined();
    expect(await reason(login({ sub: "rot" }))).toBe("user_disabled");
  });
  it("only redirects to same-site paths after login", async () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil", "/api/auth/logout"]) {
      const b = await oidc.begin(bad);
      const st = new URL(b.url); idp.claims = { nonce: st.searchParams.get("nonce"), sub: "r", groups: ["vantage"] };
      expect((await oidc.complete(cb(st.searchParams.get("state")!), b.cookie, {})).returnTo).toBe("/");
    }
  });
  it("fails closed when the provider is down: no login, no fallback", async () => {
    idp.down = true;
    oidc = new Oidc(f.db, f.policy, f.sessions);
    await expect(oidc.begin("/")).rejects.toThrow();
    f.s.oidc = oidc;
    const r = await handleApi(new Request("http://localhost:3000/api/auth/login"));
    expect(r.status).toBe(302); expect(r.headers.get("location")).toBe("/signed-out?error=sso_unavailable");
  });
});

describe("sessions and provider lifecycle", () => {
  it("expires on idle and absolute limits", async () => {
    const r = await login({ sub: "exp" });
    f.db.update(schema.sessions).set({ idleExpiresAt: Date.now() - 1 }).run();
    expect(f.sessions.load(r.token)).toBeUndefined();
    const r2 = await login({ sub: "exp" });
    f.db.update(schema.sessions).set({ absoluteExpiresAt: Date.now() - 1 }).run();
    expect(f.sessions.load(r2.token)).toBeUndefined();
  });
  it("stores only a hash of the session token and encrypts provider tokens", async () => {
    const r = await login({ sub: "enc" });
    const dump = JSON.stringify(f.db.select().from(schema.sessions).all());
    expect(dump).not.toContain(r.token);
    expect(dump).not.toContain('"rt"');
    expect(r.session.refreshTokenEnc).toMatch(/^v1\./);
  });
  it("back-channel logout: a valid token revokes the session; replays and malformed tokens are refused", async () => {
    const r = await login({ sub: "bc" });
    const now = Math.floor(Date.now() / 1000);
    const lt = (over: Record<string, unknown> = {}, key = good) => idToken({ iss: issuer, aud: CLIENT, iat: now, exp: now + 120, jti: `j-${Math.random()}`, sid: "sid-1", sub: "bc", events: { "http://schemas.openid.net/event/backchannel-logout": {} }, ...over }, key);
    const post = async (token: string) => (await handleApi(new Request("http://localhost:3000/api/auth/backchannel-logout", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) }))).status;
    f.s.oidc = oidc;
    expect(await post(await lt({}, evil))).toBe(400); // bad signature
    expect(await post(await lt({ aud: "other" }))).toBe(400);
    expect(await post(await lt({ iss: "https://evil.example" }))).toBe(400);
    expect(await post(await lt({ nonce: "n" }))).toBe(400); // logout tokens must not carry a nonce
    expect(await post(await lt({ events: {} }))).toBe(400);
    expect(await post(await lt({ sid: undefined, sub: undefined }))).toBe(400);
    expect(f.sessions.load(r.token)).toBeTruthy(); // none of those had any effect
    const valid = await lt({ jti: "once" });
    expect(await post(valid)).toBe(200);
    expect(f.sessions.load(r.token)).toBeUndefined();
    expect(await post(valid)).toBe(400); // replayed jti
    // Without a sid, every session of that subject ends.
    const r2 = await login({ sub: "bc" });
    expect(await post(await lt({ sid: undefined }))).toBe(200);
    expect(f.sessions.load(r2.token)).toBeUndefined();
  });
  it("reconciliation revokes a session when the provider rejects its refresh token (deactivated, locked or deleted user)", async () => {
    const r = await login({ sub: "life" });
    expect((await oidc.reconcile()).checked).toBe(0); // not due yet
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 301_000 }).run();
    expect(await oidc.reconcile()).toMatchObject({ checked: 1, revoked: 0 });
    expect(f.sessions.load(r.token)).toBeTruthy();
    idp.refreshOk = false;
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 301_000 }).run();
    expect(await oidc.reconcile()).toMatchObject({ revoked: 1 });
    expect(f.sessions.load(r.token)).toBeUndefined();
  });
  it("during a provider outage nothing is extended, and an unverifiable session is suspended, not revoked", async () => {
    const r = await login({ sub: "out" });
    idp.down = true;
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 301_000 }).run();
    expect(await oidc.reconcile()).toMatchObject({ revoked: 0, unreachable: 1 });
    expect(f.sessions.load(r.token)).toBeTruthy(); // still inside the allowed staleness
    f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 1_801_000 }).run();
    expect(f.sessions.load(r.token)).toBeUndefined();
    expect(f.sessions.isLive(r.session.id)).toBe(false); // media stops too
    idp.down = false;
    await oidc.reconcile();
    expect(f.sessions.load(r.token)).toBeTruthy(); // provider back and still valid: usable again
    expect(f.names(r.user.id)).toEqual([]); // permission records untouched throughout
  });
});

describe("group sync from the provider's group claim", () => {
  const row = (groupId: string, userId: string) => f.db.select().from(schema.groupMembers).all().find((m) => m.groupId === groupId && m.userId === userId);
  const map = (group: string, values: string[]) => f.admin.updateGroup(f.actor(f.u.admin), f.g[group], { providerValues: values });
  const due = () => f.db.update(schema.sessions).set({ lastValidatedAt: Date.now() - 301_000 }).run();

  it("adds and removes synced memberships at sign-in, and never touches manual ones", async () => {
    map("Front Desk Team", ["front-desk"]); map("Security", ["security", "guards"]);
    const r = await login({ sub: "gs", groups: ["vantage", "front-desk", "guards"] });
    expect(row(f.g["Front Desk Team"], r.user.id)?.source).toBe("provider");
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider");
    expect(f.policy.groupIds(r.user.id)).toContain(f.g["Front Desk Team"]); // policy cache was invalidated
    f.admin.setMember(f.actor(f.u.admin), f.g["Upper Level Team"], r.user.id, true); // unmapped, manual
    await login({ sub: "gs", groups: ["vantage", "guards"] });
    expect(row(f.g["Front Desk Team"], r.user.id)).toBeUndefined();
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider");
    expect(row(f.g["Upper Level Team"], r.user.id)?.source).toBe("manual");
    expect(f.policy.groupIds(r.user.id)).not.toContain(f.g["Front Desk Team"]);
    const actions = f.db.select().from(schema.auditLog).all().map((a) => a.action);
    expect(actions.filter((a) => a === "group.member.sync_add")).toHaveLength(2);
    expect(actions.filter((a) => a === "group.member.sync_remove")).toHaveLength(1);
  });
  it("keeps a manual membership when the value goes away, and an admin add turns a synced one manual", async () => {
    map("Front Desk Team", ["front-desk"]);
    const r = await login({ sub: "mix", groups: ["vantage"] });
    f.admin.setMember(f.actor(f.u.admin), f.g["Front Desk Team"], r.user.id, true);
    await login({ sub: "mix", groups: ["vantage", "front-desk"] });
    expect(row(f.g["Front Desk Team"], r.user.id)?.source).toBe("manual"); // no second row, stays manual
    await login({ sub: "mix", groups: ["vantage"] });
    expect(row(f.g["Front Desk Team"], r.user.id)?.source).toBe("manual");
    map("Security", ["security"]);
    await login({ sub: "mix", groups: ["vantage", "security"] });
    expect(() => f.admin.setMember(f.actor(f.u.admin), f.g["Security"], r.user.id, false)).toThrowError(/sign-in provider/);
    f.admin.setMember(f.actor(f.u.admin), f.g["Security"], r.user.id, true);
    await login({ sub: "mix", groups: ["vantage"] });
    expect(row(f.g["Security"], r.user.id)?.source).toBe("manual");
  });
  it("applies a mapping change at once from each person's last reported values", async () => {
    const r = await login({ sub: "late", groups: ["vantage", "night-shift"] });
    expect(f.db.select().from(schema.users).all().find((u) => u.id === r.user.id)!.providerGroups).toEqual(["night-shift", "vantage"]);
    map("Security", ["night-shift"]);
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider");
    expect(f.policy.groupIds(r.user.id)).toContain(f.g["Security"]);
    map("Security", []); // clearing the mapping removes the synced members
    expect(row(f.g["Security"], r.user.id)).toBeUndefined();
  });
  it("re-syncs during the session re-check from a verified refreshed ID token only", async () => {
    map("Security", ["security"]);
    const r = await login({ sub: "rc", groups: ["vantage", "security"] });
    idp.refreshIdClaims = { sub: "rc", groups: ["vantage", "security"] }; idp.signWith = evil; due();
    expect(await oidc.reconcile()).toMatchObject({ checked: 1, revoked: 0 });
    idp.refreshIdClaims = { sub: "someone-else", groups: ["vantage"] }; idp.signWith = undefined; due();
    await oidc.reconcile();
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider"); // neither token was used
    idp.refreshIdClaims = undefined; due();
    await oidc.reconcile();
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider"); // no ID token: unchanged
    idp.refreshIdClaims = { sub: "rc", groups: ["vantage"] }; due();
    await oidc.reconcile();
    expect(row(f.g["Security"], r.user.id)).toBeUndefined(); // value removed at the provider
    expect(f.policy.groupIds(r.user.id)).not.toContain(f.g["Security"]);
    expect(f.sessions.load(r.token)).toBeTruthy(); // the session itself carries on
  });
  it("reads a separate claim when OIDC_GROUPS_CLAIM is set, and is off with `none`", async () => {
    setConfigForTests(env({ OIDC_GROUPS_CLAIM: "realm_access.roles" })); oidc = new Oidc(f.db, f.policy, f.sessions);
    map("Security", ["guard"]);
    const r = await login({ sub: "kc", realm_access: { roles: ["guard"] } });
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider");
    setConfigForTests(env({ OIDC_GROUPS_CLAIM: "none" })); oidc = new Oidc(f.db, f.policy, f.sessions);
    await login({ sub: "kc", realm_access: { roles: [] } });
    expect(row(f.g["Security"], r.user.id)?.source).toBe("provider"); // sync off: nothing changes
    expect(() => map("Security", ["x"])).toThrowError(/sync is off/);
    f.admin.setMember(f.actor(f.u.admin), f.g["Security"], r.user.id, false); // and leftovers can be removed by hand
    expect(row(f.g["Security"], r.user.id)).toBeUndefined();
  });
  it("refuses a mapping on the all-staff group", () => {
    expect(() => map("All Staff", ["x"])).toThrowError(/already in this group/);
  });
});

describe("configuration guards", () => {
  it("refuses insecure or incomplete production settings", () => {
    const prod = { ...TEST_ENV, NODE_ENV: "production", APP_URL: "https://vantage.example", OIDC_ISSUER: "https://id.example" } as unknown as NodeJS.ProcessEnv;
    expect(() => loadConfig(prod)).not.toThrow();
    expect(() => loadConfig({ ...prod, OIDC_ALLOW_INSECURE_ISSUER: "1" })).toThrowError(/not allowed in production/);
    expect(() => loadConfig({ ...prod, OIDC_ISSUER: "http://id.example" })).toThrowError(/https/);
    expect(() => loadConfig({ ...prod, OIDC_ADMIT_CLAIM: "" })).toThrowError(/OIDC_ADMIT_CLAIM is required/);
    expect(() => loadConfig({ ...prod, OIDC_ADMIT_CLAIM: "", OIDC_ADMIT_VALUES: "", OIDC_ADMIT_ANY: "1" })).not.toThrow();
    expect(() => loadConfig({ ...prod, OIDC_ADMIT_ANY: "1" })).toThrowError(/cannot both be set/);
    expect(() => loadConfig({ ...prod, OIDC_ADMIT_CLAIM: "", OIDC_ADMIT_ANY: "1" })).toThrowError(/needs OIDC_ADMIT_CLAIM/);
    expect(() => loadConfig({ ...prod, PROTECT_TLS_INSECURE: "1" })).toThrowError(/PROTECT_TLS_INSECURE/);
    expect(() => loadConfig({ ...prod, VANTAGE_MODE: "mock" })).not.toThrow(); // mock cameras still require SSO
    expect(() => loadConfig({ ...prod, VANTAGE_MODE: "mock", OIDC_CLIENT_ID: "" })).toThrowError(/OIDC_CLIENT_ID/);
    expect(() => loadConfig({ ...prod, BOOTSTRAP_ADMIN_SUBJECT: "only-subject" })).toThrowError(/set together/);
  });
});
