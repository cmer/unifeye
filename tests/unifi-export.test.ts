import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProtectUnavailableError } from "../src/server/protect/types";
import { UnifiProtectAdapter } from "../src/server/protect/unifi";

const ORIGIN = "https://nvr.test";
let agent: MockAgent, dir: string, adapter: UnifiProtectAdapter;

beforeEach(async () => {
  agent = new MockAgent(); agent.disableNetConnect();
  dir = await mkdtemp(join(tmpdir(), "vantage-export-"));
  adapter = new UnifiProtectAdapter("nvr", { host: "nvr.test", username: "viewer", password: "pw", verifyTls: true, exportDispatcher: agent });
});
afterEach(async () => { await adapter.close(); await agent.close(); await rm(dir, { recursive: true, force: true }); });

const signIn = (cookie = "TOKEN=abc") => {
  const pool = agent.get(ORIGIN);
  pool.intercept({ path: "/", method: "GET" }).reply(200, "", { headers: { "x-csrf-token": "root-csrf" } });
  pool.intercept({ path: "/api/auth/login", method: "POST", headers: { "x-csrf-token": "root-csrf" }, body: (b) => JSON.parse(b).username === "viewer" })
    .reply(200, "{}", { headers: { "set-cookie": [`other=1; Path=/`, `${cookie}; Path=/; HttpOnly`], "x-updated-csrf-token": "csrf-2" } });
};
const exportPath = (start: number, end: number) => `/proxy/protect/api/video/export?camera=cam1&start=${start}&end=${end}&channel=0`;

describe("UniFi clip export", () => {
  it("signs in once, streams the body to disk and reuses the session", async () => {
    signIn();
    const body = Buffer.alloc(64 * 1024, 7), pool = agent.get(ORIGIN);
    for (const s of [1000, 3000]) pool.intercept({ path: exportPath(s, s + 1000), method: "GET", headers: { cookie: "TOKEN=abc", "x-csrf-token": "csrf-2" } }).reply(200, body);
    await adapter.exportClip("cam1", 1000, 2000, join(dir, "a.mp4"), { quality: "focus" });
    await adapter.exportClip("cam1", 3000, 4000, join(dir, "b.mp4"), { quality: "focus" });
    expect((await readFile(join(dir, "a.mp4"))).equals(body)).toBe(true);
    expect((await readFile(join(dir, "b.mp4"))).length).toBe(body.length);
    agent.assertNoPendingInterceptors();
  });

  it("signs in again once after a 401", async () => {
    signIn("TOKEN=old"); signIn("TOKEN=new");
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: exportPath(1000, 2000), method: "GET", headers: { cookie: "TOKEN=old" } }).reply(401, "");
    pool.intercept({ path: exportPath(1000, 2000), method: "GET", headers: { cookie: "TOKEN=new" } }).reply(200, Buffer.alloc(4096, 1));
    await adapter.exportClip("cam1", 1000, 2000, join(dir, "c.mp4"), { quality: "focus" });
    expect((await readFile(join(dir, "c.mp4"))).length).toBe(4096);
    agent.assertNoPendingInterceptors();
  });

  it("reports nothing recorded for a refusal or an empty clip, and a failed sign-in as unavailable", async () => {
    signIn();
    const pool = agent.get(ORIGIN);
    pool.intercept({ path: exportPath(1000, 2000), method: "GET" }).reply(404, "");
    pool.intercept({ path: exportPath(3000, 4000), method: "GET" }).reply(200, "tiny");
    await expect(adapter.exportClip("cam1", 1000, 2000, join(dir, "d.mp4"), { quality: "focus" })).rejects.toMatchObject({ name: "NoRecordingError" });
    await expect(adapter.exportClip("cam1", 3000, 4000, join(dir, "e.mp4"), { quality: "focus" })).rejects.toMatchObject({ name: "NoRecordingError" });

    const other = new UnifiProtectAdapter("nvr", { host: "nvr.test", username: "viewer", password: "pw", verifyTls: true, exportDispatcher: agent });
    pool.intercept({ path: "/", method: "GET" }).reply(200, "", { headers: { "x-csrf-token": "t" } });
    pool.intercept({ path: "/api/auth/login", method: "POST" }).reply(403, "");
    await expect(other.exportClip("cam1", 1000, 2000, join(dir, "f.mp4"))).rejects.toBeInstanceOf(ProtectUnavailableError);
    await other.close();
  });
});
