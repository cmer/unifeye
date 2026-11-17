import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleApi } from "@/server/api";
import { startHookServer } from "@/server/media/hook-server";
import { MTX_API_USER } from "@/server/media/mediamtx";
import { makeFixture, type Fixture } from "@/server/testing/fixture";

/**
 * MediaMTX's auth hook is served on its own listener, never on the web port, so no reverse proxy or
 * tunnel in front of Unifeye can reach it. The fixture's secrets are "hook" and "api". These tests
 * go through the listener, `authorizeHook` and the real gateway together.
 */
let f: Fixture, server: Server, base = "";
beforeEach(async () => {
  f = makeFixture();
  server = await startHookServer(f.s.media, { host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

const apiCall = { action: "api", user: MTX_API_USER, password: "api", ip: "127.0.0.1" };
const post = (path: string, body: unknown, raw?: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });

describe("media hook listener", () => {
  it("allows a call with the shared secret and denies one without it", async () => {
    expect((await post("/mediamtx-auth?secret=hook", apiCall)).status).toBe(200);
    expect((await post("/mediamtx-auth?secret=wrong", apiCall)).status).toBe(401);
    expect((await post("/mediamtx-auth", apiCall)).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", { ...apiCall, password: "wrong" })).status).toBe(401);
  });
  it("denies a malformed body and refuses an oversized one", async () => {
    expect((await post("/mediamtx-auth?secret=hook", null, "{not json")).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", null, "null")).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", null, JSON.stringify({ ...apiCall, pad: "x".repeat(70_000) }))).status).toBe(413);
  });
  it("serves nothing else", async () => {
    expect((await fetch(`${base}/mediamtx-auth?secret=hook`)).status).toBe(404);
    expect((await post("/", apiCall)).status).toBe(404);
    expect((await post("/api/internal/mediamtx-auth?secret=hook", apiCall)).status).toBe(404);
  });
  it("is not served on the web port, even with the secret", async () => {
    for (const p of ["/internal/mediamtx-auth?secret=hook", "/mediamtx-auth?secret=hook"]) {
      const res = await handleApi(new Request(`http://localhost:3000/api${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(apiCall) }));
      expect(res.status, p).toBe(404);
    }
  });
  it("admits a viewer only through the gateway's ticket check", async () => {
    // An HLS ticket can be presented again for 30 s, so one issued through the gateway can be sent here too.
    const cam = f.cam["Front Entrance"], path = `c_${cam}_wall`;
    const { token } = f.sessions.create(f.u.front, {});
    const list = await handleApi(new Request(`http://localhost:3000/api/media/live/${cam}/hls/wall/index.m3u8`, { headers: { cookie: `unifeye_session=${token}` } }));
    expect(list.status).toBe(200);
    const ticket = f.relay.tickets[0], read = { action: "read", protocol: "hls", path, token: ticket, id: "mtx-hls-1", ip: "203.0.113.9" };
    expect((await post("/mediamtx-auth?secret=hook", read)).status).toBe(200);
    expect((await post("/mediamtx-auth?secret=wrong", read)).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", { ...read, token: "guess" })).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", { ...read, path: `c_${cam}_focus` })).status).toBe(401); // bound to its stream
    expect((await post("/mediamtx-auth?secret=hook", { ...read, protocol: "webrtc" })).status).toBe(401); // and its transport
    // MediaMTX's own login gets no further than a ticket would: a viewer needs a ticket, and none names `_src`.
    expect((await post("/mediamtx-auth?secret=hook", { action: "read", protocol: "webrtc", user: "unifeye-publisher", password: "api", ip: "127.0.0.1", path: `${path}_src`, id: "r2" })).status).toBe(401);
    expect((await post("/mediamtx-auth?secret=hook", { action: "read", protocol: "hls", user: "unifeye-publisher", password: "api", ip: "127.0.0.1", path, id: "r3" })).status).toBe(401);
  });
  it("fails to start when its port is taken, rather than running without it", async () => {
    const port = (server.address() as AddressInfo).port;
    await expect(startHookServer(f.s.media, { host: "127.0.0.1", port })).rejects.toThrow(/EADDRINUSE/);
  });
});
