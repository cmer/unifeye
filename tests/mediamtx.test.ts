import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { MediaMtxRelay } from "@/server/media/mediamtx";
import { RelayUnavailable } from "@/server/media/relay";
import { TEST_ENV } from "@/server/testing/fixture";

/**
 * Pins the requests the MediaMTX adapter sends, against a local stub that records them. The stub is
 * not MediaMTX: these tests say what Vantage sends and how it reads the answers it expects, not
 * that MediaMTX accepts it. That was checked by hand against MediaMTX 1.21.4.
 */
interface Seen { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
let server: Server, base = "", seen: Seen[] = [], down = false;
let answer: (req: Seen, res: ServerResponse) => void;
const ok = (res: ServerResponse, body: unknown = {}) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const status = (code: number) => (_: Seen, res: ServerResponse) => { res.writeHead(code); res.end(); };
const API_AUTH = "Basic " + Buffer.from("vantage-api:api").toString("base64");

beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (down) return void req.socket.destroy();
    let body = ""; for await (const c of req) body += c;
    const r = { method: req.method!, url: req.url!, headers: req.headers, body };
    seen.push(r);
    answer(r, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

let relay: MediaMtxRelay;
beforeEach(() => {
  // Distinct prefixes show which listener each call is addressed to.
  setConfigForTests(loadConfig({ ...TEST_ENV, MEDIAMTX_API_URL: base, MEDIAMTX_WHEP_URL: `${base}/whep-listener`, MEDIAMTX_HLS_URL: `${base}/hls-listener` } as unknown as NodeJS.ProcessEnv));
  relay = new MediaMtxRelay();
  seen = []; down = false; answer = (_, res) => ok(res);
});
const lines = () => seen.map((r) => `${r.method} ${r.url}`);

describe("MediaMTX adapter: control API", () => {
  it("adds an on-demand RTSP path with the API credentials, once per configuration", async () => {
    await relay.ensureStream("c_cam1_wall", { kind: "rtsp", url: "rtsps://nvr/secret", tlsFingerprint: "AB:CD" });
    expect(lines()).toEqual(["POST /v3/config/paths/add/c_cam1_wall"]);
    expect(seen[0].headers.authorization).toBe(API_AUTH);
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(JSON.parse(seen[0].body)).toEqual({ source: "rtsps://nvr/secret", sourceOnDemand: true, sourceOnDemandCloseAfter: "10s", rtspTransport: "tcp", sourceFingerprint: "AB:CD" });
    await relay.ensureStream("c_cam1_wall", { kind: "rtsp", url: "rtsps://nvr/secret", tlsFingerprint: "AB:CD" });
    expect(seen).toHaveLength(1); // unchanged: no call
    await relay.ensureStream("c_cam1_wall", { kind: "rtsp", url: "rtsps://nvr/rotated" });
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[1].body)).toEqual({ source: "rtsps://nvr/rotated", sourceOnDemand: true, sourceOnDemandCloseAfter: "10s", rtspTransport: "tcp" });
  });
  it("configures a command source as a publisher path, and replaces a path that already exists", async () => {
    answer = (r, res) => (r.url.includes("/add/") ? status(400)(r, res) : ok(res));
    await relay.ensureStream("c_cam1_focus", { kind: "command", command: "ffmpeg -i x" });
    expect(lines()).toEqual(["POST /v3/config/paths/add/c_cam1_focus", "POST /v3/config/paths/replace/c_cam1_focus"]);
    expect(JSON.parse(seen[1].body)).toEqual({ source: "publisher", runOnDemand: "ffmpeg -i x", runOnDemandRestart: true, runOnDemandCloseAfter: "10s" });
    expect(seen[1].headers.authorization).toBe(API_AUTH);
    answer = status(500);
    await expect(relay.ensureStream("c_cam2_wall", { kind: "command", command: "x" })).rejects.toThrow(/path setup failed \(500\)/);
  });
  it("lists readers page by page and kicks by id", async () => {
    answer = (r, res) => ok(res, r.url.endsWith("page=0") ? { pageCount: 2, items: [{ id: "a", path: "p" }] } : { pageCount: 2, items: [{ id: "b", path: "p" }] });
    expect((await relay.readers("webrtc")).map((x) => x.id)).toEqual(["a", "b"]);
    expect(lines()).toEqual(["GET /v3/webrtc/sessions/list?itemsPerPage=100&page=0", "GET /v3/webrtc/sessions/list?itemsPerPage=100&page=1"]);
    expect(seen[0].headers.authorization).toBe(API_AUTH);
    seen = []; answer = (_, res) => ok(res, { pageCount: 0, items: [] });
    expect(await relay.readers("hls")).toEqual([]);
    expect(lines()).toEqual(["GET /v3/hls/sessions/list?itemsPerPage=100&page=0"]);
    seen = [];
    await relay.kick("webrtc", "a b"); await relay.kick("hls", "h1");
    expect(lines()).toEqual(["POST /v3/webrtc/sessions/kick/a%20b", "POST /v3/hls/sessions/kick/h1"]);
    expect(seen[0].headers.authorization).toBe(API_AUTH); expect(seen[0].body).toBe("");
    answer = status(500);
    await expect(relay.readers("webrtc")).rejects.toThrow(/list failed/);
  });
  it("reports health from the paths list, and an unreachable relay as down without throwing", async () => {
    expect(await relay.healthy()).toBe(true);
    expect(lines()).toEqual(["GET /v3/paths/list?itemsPerPage=1"]);
    expect(seen[0].headers.authorization).toBe(API_AUTH);
    answer = status(401);
    expect(await relay.healthy()).toBe(false);
    down = true;
    expect(await relay.healthy()).toBe(false);
    await expect(relay.kick("webrtc", "a")).resolves.toBeUndefined();
    await expect(relay.readers("webrtc")).rejects.toBeInstanceOf(RelayUnavailable);
    await expect(relay.ensureStream("c_cam1_wall", { kind: "command", command: "x" })).rejects.toBeInstanceOf(RelayUnavailable);
  });
});

describe("MediaMTX adapter: forgetting configured paths when MediaMTX may have restarted", () => {
  const src = { kind: "command", command: "x" } as const;
  const adds = () => seen.filter((r) => r.url.includes("/config/paths/add/")).map((r) => r.url.split("/").pop());
  beforeEach(async () => { await relay.ensureStream("c_a_wall", src); await relay.ensureStream("c_b_wall", src); seen = []; });
  const again = async () => { seen = []; down = false; answer = (_, res) => ok(res); await relay.ensureStream("c_a_wall", src); await relay.ensureStream("c_b_wall", src); return adds(); };

  it("keeps the cache while nothing is wrong", async () => { expect(await again()).toEqual([]); });
  it("forgets everything when a request cannot connect", async () => {
    down = true;
    await expect(relay.whepCreate("c_a_wall", "t", "o")).rejects.toBeInstanceOf(RelayUnavailable);
    expect(await again()).toEqual(["c_a_wall", "c_b_wall"]);
    down = true;
    await expect(relay.hlsReader("c_a_wall", "t").fetch("index.m3u8", "")).rejects.toBeInstanceOf(RelayUnavailable);
    expect(await again()).toEqual(["c_a_wall", "c_b_wall"]);
    down = true;
    await relay.kick("hls", "x");
    expect(await again()).toEqual(["c_a_wall", "c_b_wall"]);
  });
  it("forgets everything when the health check fails", async () => {
    answer = status(500);
    expect(await relay.healthy()).toBe(false);
    expect(await again()).toEqual(["c_a_wall", "c_b_wall"]);
  });
  it("forgets one stream when MediaMTX does not have it", async () => {
    answer = status(404);
    expect(await relay.whepCreate("c_a_wall", "t", "o")).toEqual({ outcome: "no_stream" });
    expect(await again()).toEqual(["c_a_wall"]);
    answer = status(404);
    expect(await relay.hlsReader("c_b_wall", "t").fetch("index.m3u8", "")).toEqual({ outcome: "not_found" });
    expect(await again()).toEqual(["c_b_wall"]);
    answer = status(404);
    expect(await relay.hlsReader("c_b_wall", "t").fetch("seg9.mp4", "")).toEqual({ outcome: "not_found" }); // a segment that aged out is not a missing path
    expect(await again()).toEqual([]);
  });
});

describe("MediaMTX adapter: WHEP", () => {
  it("posts the offer with the ticket as a Bearer token and reads the resource from the location", async () => {
    answer = (_, res) => { res.writeHead(201, { "content-type": "application/sdp", location: "/c_cam1_wall/whep/0a1b2c3d-secret", etag: '"e1"' }); res.end("v=0 answer"); };
    expect(await relay.whepCreate("c_cam1_wall", "TICKET", "v=0 offer")).toEqual({ outcome: "created", sdp: "v=0 answer", resource: "0a1b2c3d-secret", etag: '"e1"' });
    expect(lines()).toEqual(["POST /whep-listener/c_cam1_wall/whep"]);
    expect(seen[0].headers.authorization).toBe("Bearer TICKET");
    expect(seen[0].headers["content-type"]).toBe("application/sdp");
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].body).toBe("v=0 offer");
  });
  it("maps a refusal to failed and a missing stream to no_stream", async () => {
    answer = status(401);
    expect(await relay.whepCreate("c_cam1_wall", "bad", "o")).toEqual({ outcome: "failed" });
    answer = status(404);
    expect(await relay.whepCreate("c_cam1_wall", "t", "o")).toEqual({ outcome: "no_stream" });
    answer = (_, res) => { res.writeHead(201); res.end("v=0"); }; // no location: the caller rejects the empty resource
    expect(await relay.whepCreate("c_cam1_wall", "t", "o")).toMatchObject({ outcome: "created", resource: "" });
  });
  it("forwards trickle and teardown to the resource with only the given headers, no credentials", async () => {
    answer = status(204);
    expect(await relay.whepTrickle("c_cam1_wall", "0a1b2c3d-secret", "a=candidate", { "content-type": "application/trickle-ice-sdpfrag", "if-match": '"e1"' })).toBe(204);
    answer = status(200);
    expect(await relay.whepClose("c_cam1_wall", "0a1b2c3d-secret", {})).toBe(200);
    answer = status(404);
    expect(await relay.whepClose("c_cam1_wall", "0a1b2c3d-secret", {})).toBe(404);
    expect(lines().slice(0, 2)).toEqual(["PATCH /whep-listener/c_cam1_wall/whep/0a1b2c3d-secret", "DELETE /whep-listener/c_cam1_wall/whep/0a1b2c3d-secret"]);
    expect(seen[0].headers["content-type"]).toBe("application/trickle-ice-sdpfrag"); expect(seen[0].headers["if-match"]).toBe('"e1"'); expect(seen[0].body).toBe("a=candidate");
    expect(seen[0].headers.authorization).toBeUndefined(); expect(seen[1].headers.authorization).toBeUndefined(); expect(seen[1].body).toBe("");
    down = true;
    await expect(relay.whepTrickle("c_cam1_wall", "x", "a", {})).rejects.toBeInstanceOf(RelayUnavailable);
  });
});

describe("MediaMTX adapter: HLS", () => {
  it("follows the redirect, keeps the session cookie for that reader, and sends the ticket every time", async () => {
    answer = (r, res) => {
      if (r.url === "/hls-listener/c_cam1_wall/index.m3u8?_HLS_msn=3") { res.writeHead(302, { location: "index.m3u8?session=s1", "set-cookie": ["mtx_hls=s1; Path=/c_cam1_wall/; HttpOnly", "other=2; Max-Age=60"] }); return res.end(); }
      res.writeHead(200, { "content-type": r.url.includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4" }); res.end(r.url.includes(".m3u8") ? "#EXTM3U" : "bytes");
    };
    const reader = relay.hlsReader("c_cam1_wall", "TICKET");
    expect(seen).toHaveLength(0); // nothing is sent until a file is asked for
    const list = await reader.fetch("index.m3u8", "?_HLS_msn=3");
    expect(list).toMatchObject({ outcome: "ok", contentType: "application/vnd.apple.mpegurl" });
    expect(list.outcome === "ok" && await new Response(list.body).text()).toBe("#EXTM3U");
    const seg = await reader.fetch("seg1.mp4", "");
    expect(seg.outcome === "ok" && await new Response(seg.body).text()).toBe("bytes");
    expect(lines()).toEqual(["GET /hls-listener/c_cam1_wall/index.m3u8?_HLS_msn=3", "GET /hls-listener/c_cam1_wall/index.m3u8?session=s1", "GET /hls-listener/c_cam1_wall/seg1.mp4"]);
    expect(seen.map((r) => r.headers.authorization)).toEqual(["Bearer TICKET", "Bearer TICKET", "Bearer TICKET"]);
    expect(seen.map((r) => r.headers.cookie)).toEqual([undefined, "mtx_hls=s1; other=2", "mtx_hls=s1; other=2"]);
    // Another reader of the same stream starts without that cookie.
    seen = [];
    await relay.hlsReader("c_cam1_wall", "OTHER").fetch("seg1.mp4", "");
    expect(seen[0].headers.cookie).toBeUndefined(); expect(seen[0].headers.authorization).toBe("Bearer OTHER");
  });
  it("maps 404 to not_found, other errors to failed, and gives up on a redirect loop", async () => {
    answer = status(404);
    expect(await relay.hlsReader("c_cam1_wall", "t").fetch("seg1.mp4", "")).toEqual({ outcome: "not_found" });
    answer = status(401);
    expect(await relay.hlsReader("c_cam1_wall", "t").fetch("index.m3u8", "")).toEqual({ outcome: "failed" });
    seen = []; answer = (_, res) => { res.writeHead(302, { location: "/hls-listener/c_cam1_wall/index.m3u8" }); res.end(); };
    expect(await relay.hlsReader("c_cam1_wall", "t").fetch("index.m3u8", "")).toEqual({ outcome: "failed" });
    expect(seen).toHaveLength(4);
  });
});
