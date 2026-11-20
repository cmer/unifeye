import { createHmac } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { loadConfig } from "@/server/config";
import { CoturnProvider, stunPing, TURN_LOGIN_MS, turnProvider } from "@/server/media/turn";
import { makeFixture, TEST_ENV, type Fixture } from "@/server/testing/fixture";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const env = (over: Record<string, string>) => loadConfig({ ...TEST_ENV, ...over } as unknown as NodeJS.ProcessEnv);
const turnEnv = (over: Record<string, string> = {}) => env({ TURN_HOST: "turn.example.com", TURN_SECRET: SECRET, ...over });

describe("TURN settings", () => {
  it("are off unless TURN_HOST is set", () => {
    const c = env({});
    expect(c.TURN_HOST).toBeUndefined();
    expect(c.TURN_RELAY_ONLY).toBe(false);
  });
  it("need the host and the secret together, and a long secret", () => {
    expect(() => env({ TURN_HOST: "turn.example.com" })).toThrow(/TURN_HOST and TURN_SECRET must be set together/);
    expect(() => env({ TURN_SECRET: SECRET })).toThrow(/TURN_HOST and TURN_SECRET must be set together/);
    expect(() => turnEnv({ TURN_SECRET: "short" })).toThrow(/TURN_SECRET must be at least 32/);
    expect(() => env({ TURN_RELAY_ONLY: "1" })).toThrow(/TURN_RELAY_ONLY needs TURN_HOST/);
  });
  it("take a bare host name, not a URL", () => {
    expect(() => turnEnv({ TURN_HOST: "turn:turn.example.com" })).toThrow(/TURN_HOST/);
    expect(() => turnEnv({ TURN_HOST: "turn.example.com:3478" })).toThrow(/TURN_HOST/);
    expect(turnEnv({ TURN_HOST: "203.0.113.7" }).TURN_HOST).toBe("203.0.113.7");
  });
  it("treat an empty TURN_HOST as unset, as compose passes it", () => {
    expect(env({ TURN_HOST: "", TURN_SECRET: "" }).TURN_HOST).toBeUndefined();
  });
});

describe("coturn logins", () => {
  const now = 1_800_000_000_000;
  it("follow coturn's shared-secret convention and expire after 12 hours", async () => {
    const r = await new CoturnProvider(turnEnv(), () => now).issue("session-1");
    expect(r.expiresAt).toBe(now + TURN_LOGIN_MS);
    expect(r.relayOnly).toBe(false);
    expect(r.relayDown).toBeUndefined();
    const [s] = r.iceServers;
    const [expiry, label] = s.username!.split(":");
    expect(Number(expiry)).toBe((now + TURN_LOGIN_MS) / 1000);
    expect(label).toMatch(/^[0-9a-f]{16}$/);
    expect(s.username).not.toContain("session-1"); // the relay never sees the session
    expect(s.credential).toBe(createHmac("sha1", SECRET).update(s.username!).digest("base64"));
    expect(s.urls).toEqual(["turn:turn.example.com:3478?transport=udp", "turn:turn.example.com:3478?transport=tcp", "turns:turn.example.com:443?transport=tcp"]);
  });
  it("use the configured ports, and leave TLS out with TURN_TLS_PORT=0", async () => {
    const r = await new CoturnProvider(turnEnv({ TURN_PORT: "3479", TURN_TLS_PORT: "0", TURN_RELAY_ONLY: "1" }), () => now).issue("s");
    expect(r.iceServers[0].urls).toEqual(["turn:turn.example.com:3479?transport=udp", "turn:turn.example.com:3479?transport=tcp"]);
    expect(r.relayOnly).toBe(true);
  });
  it("say when the relay did not answer its last check", async () => {
    let up = false;
    const p = new CoturnProvider(turnEnv(), () => now, async () => up);
    expect(p.answering()).toBe(true); // before the first check
    expect(await p.check()).toBe(false);
    expect((await p.issue("s")).relayDown).toBe(true);
    up = true;
    await p.check();
    expect((await p.issue("s")).relayDown).toBeUndefined();
  });
  it("are not issued without a relay", async () => {
    const p = turnProvider(env({}));
    expect(await p.issue("s")).toEqual({ iceServers: [], relayOnly: false, expiresAt: null });
    expect(await p.check()).toBeNull();
    expect(p.answering()).toBeNull();
  });
});

describe("relay check", () => {
  let server: Socket | undefined;
  afterEach(() => server?.close());
  const listen = (answer: boolean) => new Promise<number>((resolve) => {
    server = createSocket("udp4");
    server.on("message", (m, from) => {
      if (!answer || m.readUInt16BE(0) !== 0x0001) return;
      const res = Buffer.from(m.subarray(0, 20));
      res.writeUInt16BE(0x0101, 0); // Binding success, same transaction
      server!.send(res, from.port, from.address);
    });
    server.bind(0, "127.0.0.1", () => resolve(server!.address().port));
  });
  it("passes when the relay answers a STUN request", async () => {
    expect(await stunPing("127.0.0.1", await listen(true), 600)).toBe(true);
  });
  it("fails when nothing answers", async () => {
    expect(await stunPing("127.0.0.1", await listen(false), 300)).toBe(false);
  });
});

describe("GET /api/media/ice", () => {
  let f: Fixture;
  beforeEach(() => { f = makeFixture(); });
  const get = async (userId: string) => {
    const c = f.sessions.create(userId, {});
    const res = await handleApi(new Request("http://localhost:3000/api/media/ice", { headers: { cookie: `unifeye_session=${c.token}` } }));
    return { status: res.status, body: await res.json() as { iceServers: { username?: string }[]; relayOnly: boolean; relayDown?: boolean } };
  };
  it("is empty without a relay", async () => {
    expect((await get(f.u.front)).body).toEqual({ iceServers: [], relayOnly: false, expiresAt: null });
  });
  it("gives a login to someone who can watch a camera", async () => {
    f.s.turn = new CoturnProvider(turnEnv({ TURN_RELAY_ONLY: "1" }));
    const r = await get(f.u.front);
    expect(r.status).toBe(200);
    expect(r.body.iceServers[0].username).toMatch(/^\d+:[0-9a-f]{16}$/);
    expect(r.body.relayOnly).toBe(true);
  });
  it("gives nothing to someone who can see no camera", async () => {
    f.s.turn = new CoturnProvider(turnEnv());
    expect((await get(f.u.nobody)).body.iceServers).toEqual([]);
  });
  it("needs a session", async () => {
    expect((await handleApi(new Request("http://localhost:3000/api/media/ice"))).status).toBe(401);
  });
});
