import { eq } from "drizzle-orm";
import { existsSync, readdirSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleApi } from "@/server/api";
import { config } from "@/server/config";
import { schema } from "@/server/db";
import { makeFixture, type Fixture } from "@/server/testing/fixture";
import { HLS_PLAYLIST } from "@/server/testing/relay";

let f: Fixture;
const tokens = new Map<string, { token: string; csrf: string }>();
function sess(userId: string, fresh = false) {
  let t = fresh ? undefined : tokens.get(userId);
  if (!t) { const c = f.sessions.create(userId, {}); t = { token: c.token, csrf: c.session.csrfSecret }; tokens.set(userId, t); }
  return t;
}
async function call(userId: string | null, method: string, path: string, o: { body?: unknown; raw?: string; preview?: string; csrf?: boolean; headers?: Record<string, string>; session?: { token: string; csrf: string } } = {}) {
  const h: Record<string, string> = { ...o.headers };
  if (userId) { const t = o.session ?? sess(userId); h.cookie = `unifeye_session=${t.token}`; if (o.csrf !== false && method !== "GET") h["x-csrf-token"] = t.csrf; }
  if (o.preview) h["x-unifeye-preview"] = o.preview;
  if (o.body !== undefined) h["content-type"] = "application/json";
  const res = await handleApi(new Request(`http://localhost:3000/api${path}`, { method, headers: h, body: o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body)) }));
  const text = res.headers.get("content-type")?.includes("json") ? await res.clone().text() : "";
  return { res, status: res.status, data: text ? JSON.parse(text) : undefined, text };
}
const wait = async (fn: () => Promise<boolean>, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timed out"); };

beforeEach(() => {
  tokens.clear();
  f = makeFixture();
  (config() as { MEDIA_CACHE_DIR: string }).MEDIA_CACHE_DIR = mkdtempSync(join(tmpdir(), "unifeye-test-"));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("authentication boundary", () => {
  it("returns 401 for every data and media route without a session", async () => {
    const cam = f.cam["Front Entrance"];
    for (const [m, p] of [["GET", "/me"], ["GET", "/cameras"], ["GET", `/cameras/${cam}/snapshot`], ["GET", `/cameras/${cam}/recordings?from=1&to=2`], ["GET", `/cameras/${cam}/playback?t=1`], ["GET", `/cameras/${cam}/playback/info?t=1`], ["POST", `/media/live/${cam}/whep`], ["GET", `/media/live/${cam}/hls/wall/index.m3u8`], ["GET", "/events"], ["GET", "/events/stream"], ["GET", "/events/x/thumbnail"], ["POST", "/exports"], ["GET", "/exports/x"], ["GET", "/exports/x/download"], ["GET", "/admin/overview"], ["GET", "/views/x"]] as const)
      expect((await call(null, m, p)).status, `${m} ${p}`).toBe(401);
  });
  it("with passwords off (the default), has no password, registration or link routes at all", async () => {
    const origin = { origin: "http://localhost:3000" };
    for (const p of ["/auth/register", "/auth/password", "/auth/password-link", "/auth/password-link/check", "/auth/reset", "/auth/local", "/login"]) for (const m of ["GET", "POST"]) expect((await call(null, m, p, { body: m === "POST" ? {} : undefined, headers: origin })).status, `${m} ${p}`).toBe(404);
    expect((await call(null, "POST", "/auth/login", { body: { username: "a", password: "b" } })).status).toBe(404); // login is a GET redirect to the identity provider only
    expect((await call(f.u.admin, "POST", "/admin/users", { body: { name: "X", username: "xx" } })).status).toBe(400);
    expect((await call(f.u.front, "POST", "/me/password", { body: { current: "a", next: "b" } })).status).toBe(404);
    expect(f.db.select().from(schema.localCredentials).all()).toEqual([]);
  });
  it("rejects cookie-authenticated writes without the CSRF token or from another origin", async () => {
    expect((await call(f.u.admin, "PUT", "/preferences", { body: { key: "theme", value: "dark" }, csrf: false })).data.error).toBe("bad_csrf_token");
    expect((await call(f.u.admin, "PUT", "/preferences", { body: { key: "theme", value: "dark" }, headers: { origin: "https://evil.example" } })).data.error).toBe("bad_origin");
    expect((await call(f.u.admin, "PUT", "/preferences", { body: { key: "theme", value: "dark" } })).status).toBe(200);
  });
  it("logout ends the session immediately", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("provider down"); }));
    const r = await call(f.u.front, "POST", "/auth/logout");
    expect(r.status).toBe(200);
    expect(r.res.headers.get("set-cookie")).toMatch(/unifeye_session=;.*Max-Age=0/);
    expect((await call(f.u.front, "GET", "/me")).status).toBe(401);
  });
  it("staff cannot reach administration, whatever they send", async () => {
    expect((await call(f.u.front, "GET", "/admin/overview")).status).toBe(403);
    expect((await call(f.u.front, "PUT", "/admin/grants", { body: { userId: f.u.front, cameraId: f.cam["Server Closet"], on: true }, headers: { "x-user-id": f.u.admin, "x-role": "admin" } })).status).toBe(403);
    expect(f.policy.canAccessCamera(f.u.front, f.cam["Server Closet"])).toBe(false);
  });
});

describe("a forbidden camera is indistinguishable from a missing one, on every route", () => {
  it("covers metadata, images, recordings, playback, live setup, events and exports", async () => {
    const bad = f.cam["Server Closet"], none = "00000000-0000-4000-8000-000000000000", t = Date.now() - 3600e3;
    const paths = (id: string): [string, string, unknown?][] => [["GET", `/cameras/${id}/snapshot`], ["GET", `/cameras/${id}/snapshot?at=${t}`], ["GET", `/cameras/${id}/recordings?from=${t - 1000}&to=${t}`], ["GET", `/cameras/${id}/playback?t=${t}`], ["GET", `/cameras/${id}/playback/info?t=${t}`], ["GET", `/cameras/${id}/playback?t=${t}&layer=high`], ["POST", `/media/live/${id}/whep?q=focus`], ["GET", `/media/live/${id}/hls/wall/index.m3u8`], ["GET", `/media/live/${id}/hls/wall/seg1.mp4`], ["GET", `/events?cameraId=${id}`], ["POST", "/exports", { cameraId: id, startMs: t, endMs: t + 5000 }]];
    const forbidden = await Promise.all(paths(bad).map(([m, p, b]) => call(f.u.front, m, p, { body: b })));
    const missing = await Promise.all(paths(none).map(([m, p, b]) => call(f.u.front, m, p, { body: b })));
    forbidden.forEach((r, i) => { expect(r.status, paths(bad)[i][1]).toBe(404); expect(r.text).toBe(missing[i].text); expect(r.text).not.toContain("Server Closet"); });
  });
  it("lists only authorized cameras and tags", async () => {
    const r = await call(f.u.front, "GET", "/cameras");
    expect(r.data.cameras.map((c: { name: string }) => c.name)).toEqual(["Front Entrance", "Loading Dock", "Lobby Front Desk", "Reception Waiting"]);
    expect(r.text).not.toMatch(/Server Closet|restricted|upper_level/);
    const tags = (await call(f.u.front, "GET", "/tags")).data.tags.map((x: { name: string }) => x.name);
    expect(tags).not.toContain("restricted");
    expect((await call(f.u.nobody, "GET", "/cameras")).data.cameras).toEqual([]);
  });
  it("returns a sanitized view: shared views expose nothing about forbidden cameras", async () => {
    const r = await call(f.u.front, "GET", `/views/${f.viewByName()["Building Overview"]}`);
    expect(r.data.cameras.map((c: { name: string }) => c.name)).toEqual(["Front Entrance", "Lobby Front Desk", "Loading Dock"]);
    expect(r.data.definition.cameraIds).toHaveLength(3);
    expect(r.data.sharing).toBeNull();
    for (const leak of ["Stock Room", f.cam["Stock Room"], f.cam["Upper Lounge"], f.cam["Parking Lot North"]]) expect(r.text).not.toContain(leak);
    expect((await call(f.u.front, "GET", `/views/${f.viewByName()["Restricted Rooms"]}`)).status).toBe(404);
    const me = (await call(f.u.front, "GET", "/me")).data;
    expect(me.views.find((v: { name: string }) => v.name === "Building Overview").count).toBe(3);
  });
  it("event listings, counts and ids never cross the permission boundary", async () => {
    const all = (await call(f.u.admin, "GET", "/events?limit=200")).data.events as { id: string; cameraId: string }[];
    const foreign = all.find((e) => e.cameraId === f.cam["Server Closet"] || e.cameraId === f.cam["Upper Hallway East"])!;
    expect(foreign).toBeTruthy();
    const mine = (await call(f.u.front, "GET", "/events?limit=200")).data;
    const allowed = new Set(f.policy.cameraIds(f.u.front));
    expect(mine.events.length).toBeGreaterThan(0);
    expect(mine.events.every((e: { cameraId: string }) => allowed.has(e.cameraId))).toBe(true);
    const small = (await call(f.u.front, "GET", "/events?limit=3")).data;
    expect(small.events).toHaveLength(3);
    expect(small.hasMore).toBe(mine.events.length > 3);
    expect((await call(f.u.nobody, "GET", "/events")).data).toMatchObject({ events: [], hasMore: false });
    // Knowing an event id for a forbidden camera gives nothing, and looks like an unknown id.
    const a = await call(f.u.front, "GET", `/events/${foreign.id}`), b = await call(f.u.front, "GET", "/events/mock-01.1.999999");
    expect(a.status).toBe(404); expect(a.text).toBe(b.text);
    expect((await call(f.u.front, "GET", `/events/${foreign.id}/thumbnail`)).status).toBe(404);
  });
  it("one camera's timeline gets a busy day of events, not just the newest 200", async () => {
    const cam = f.cam["Front Entrance"], protectId = f.policy.camera(f.u.front, cam).protectId, to = Date.now() - 60_000, from = to - 6 * 3600e3;
    for (let i = 0; i < 400; i++) f.adapter.emit({ id: `busy.${i}`, protectCameraId: protectId, type: "motion", startMs: from + i * 50_000, endMs: from + i * 50_000 + 5000, hasThumbnail: false });
    const r = (await call(f.u.front, "GET", `/events?cameraId=${cam}&from=${from}&to=${to}&limit=1000`)).data;
    expect(r.events.filter((e: { id: string }) => e.id.startsWith("busy.")).length).toBe(400);
    expect(r.events.some((e: { id: string }) => e.id === "busy.0")).toBe(true); // the oldest is still there
    // Mixed feeds keep the smaller cap.
    expect((await call(f.u.front, "GET", `/events?from=${from}&to=${to}&limit=1000`)).data.events).toHaveLength(200);
  });
  it("authorized media works: snapshot, recording ranges and a playback window with byte ranges", async () => {
    const cam = f.cam["Front Entrance"], t = Date.now() - 2 * 3600e3;
    const snap = await call(f.u.front, "GET", `/cameras/${cam}/snapshot`);
    expect(snap.status).toBe(200); expect(snap.res.headers.get("content-type")).toBe("image/jpeg");
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 86400e3}&to=${t}`)).data;
    expect(rec.precision).toBe("exact"); expect(rec.ranges.length).toBeGreaterThan(0);
    const inside = rec.ranges[rec.ranges.length - 1][1] - 120_000;
    const pb = await call(f.u.front, "GET", `/cameras/${cam}/playback?t=${inside}`, { headers: { range: "bytes=0-99" } });
    expect(pb.status).toBe(206); expect(pb.res.headers.get("content-range")).toMatch(/^bytes 0-99\//);
    expect(Number(pb.res.headers.get("x-window-start"))).toBeLessThanOrEqual(inside);
    expect((await call(f.u.front, "GET", `/cameras/${cam}/playback?t=${Date.now() + 60000}`)).data.error).toBe("no_recording");
  });
});

describe("clip export jobs", () => {
  it("are bound to the session and camera, expire on revocation, and cannot be fetched by id alone", async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const start = rec[rec.length - 1][1] - 60_000;
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs: start, endMs: start + 5000 } })).data;
    await wait(async () => (await call(f.u.front, "GET", `/exports/${id}`)).data.status === "ready");
    expect((await call(f.u.front, "GET", `/exports/${id}/download`)).status).toBe(200);
    // Security also has this camera, but the job belongs to another session.
    expect((await call(f.u.sec, "GET", `/exports/${id}`)).status).toBe(404);
    expect((await call(f.u.sec, "GET", `/exports/${id}/download`)).status).toBe(404);
    expect((await call(f.u.front, "GET", `/exports/${id}/download`, { session: sess(f.u.front, true) })).status).toBe(404);
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, cam, false);
    expect((await call(f.u.front, "GET", `/exports/${id}/download`)).status).toBe(404);
    await wait(async () => !existsSync(file));
    expect((await call(f.u.front, "POST", "/exports", { body: { cameraId: f.cam["Front Entrance"], startMs: t - 3600e3, endMs: t + 3600e3 + 1000 } })).status).toBe(400); // longer than the clip limit
  });
  it("prepare at most two at a time per session", async () => {
    const cam = f.cam["Front Entrance"], t = Date.now() - 3 * 3600e3;
    const post = (s: number) => call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs: t + s * 60_000, endMs: t + s * 60_000 + 30_000 } });
    const [a, b, c] = await Promise.all([post(0), post(1), post(2)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(c.status).toBe(429); expect(c.data.error).toBe("too_many_exports");
    await wait(async () => (await call(f.u.front, "GET", `/exports/${a.data.id}`)).data.status !== "running" && (await call(f.u.front, "GET", `/exports/${b.data.id}`)).data.status !== "running", 20_000);
    expect((await post(3)).status).toBe(200);
  });
});

describe("long clip exports", () => {
  it("are fetched in pieces with progress, and joined without the overlap each piece starts with", async () => {
    const cfg = config() as { MEDIA_CACHE_DIR: string };
    cfg.MEDIA_CACHE_DIR = relative(process.cwd(), cfg.MEDIA_CACHE_DIR); // FFmpeg's join list must not depend on the working folder
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const [a, b] = rec.find(([x, y]) => y - x >= 12 * 60_000)!, startMs = b - 11 * 60_000, endMs = b - 30_000;
    // Like the recorder, start every export on a keyframe up to a few seconds early.
    const real = f.adapter.exportClip.bind(f.adapter), asked: [number, number][] = [];
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => { asked.push([s0, e0]); return real(id, Math.max(a, s0 - 2500), e0, dest, o); });
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs, endMs } })).data;
    const seen = new Set<number>();
    let etas = 0;
    await wait(async () => { const j = (await call(f.u.front, "GET", `/exports/${id}`)).data; seen.add(j.progress); if (j.etaMs != null) etas++; return j.status !== "running"; }, 60_000);
    expect(asked.length).toBe(3); // 10.5 minutes in 5-minute pieces
    expect([...seen].some((p) => p > 0 && p < 95)).toBe(true);
    expect(etas).toBeGreaterThan(0);
    const j = (await call(f.u.front, "GET", `/exports/${id}`)).data;
    expect(j.status).toBe("ready");
    expect(j.fileName).toMatch(/^Loading_Dock_.*\.mp4$/); expect(j.bytes).toBeGreaterThan(1024);
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    const { probe } = await import("@/server/protect/ffmpeg");
    // Only the first piece keeps its lead; the joins drop the rest.
    expect((await probe(file)).duration).toBeCloseTo((endMs - startMs) / 1000 + 2.5, 0);
  }, 90_000);

  it("play at one size when the recorder sends a low-resolution piece", async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const [, b] = rec.find(([x, y]) => y - x >= 12 * 60_000)!, startMs = b - 11 * 60_000, endMs = b - 30_000;
    // Adaptive recording: the middle five minutes had no motion, so only the low stream exists.
    const real = f.adapter.exportClip.bind(f.adapter);
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => real(id, s0, e0, dest, s0 === startMs + 5 * 60_000 ? { ...o, quality: "wall" } : o));
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs, endMs } })).data;
    await wait(async () => (await call(f.u.front, "GET", `/exports/${id}`)).data.status !== "running", 90_000);
    expect((await call(f.u.front, "GET", `/exports/${id}`)).data.status).toBe("ready");
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    const { probe, videoSizes } = await import("@/server/protect/ffmpeg");
    expect((await videoSizes(file)).sizes).toEqual([{ w: 1280, h: 720 }]);
    expect((await probe(file)).duration).toBeCloseTo((endMs - startMs) / 1000, 0);
    expect(readdirSync(dirname(file))).toEqual([basename(file)]); // no pieces or resized copies left behind
  }, 120_000);

  it("keep every minute of an adaptive recording, at the high resolution", async () => {
    const cam = f.cam["Loading Dock"], protectId = f.db.select().from(schema.cameras).where(eq(schema.cameras.id, cam)).get()!.protectId, t = Date.now() - 2 * 3600e3;
    f.adapter.adaptive.add(protectId); // high resolution only in seconds 12-21 of every half minute
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const [, b] = rec.find(([x, y]) => y - x >= 12 * 60_000)!, startMs = Math.floor((b - 11 * 60_000) / 60_000) * 60_000, endMs = startMs + 6 * 60_000;
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs, endMs } })).data;
    await wait(async () => (await call(f.u.front, "GET", `/exports/${id}`)).data.status !== "running", 110_000);
    expect((await call(f.u.front, "GET", `/exports/${id}`)).data.status).toBe("ready");
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    const { probe, videoSizes } = await import("@/server/protect/ffmpeg");
    expect((await videoSizes(file)).sizes).toEqual([{ w: 1280, h: 720 }]);
    // Six minutes, plus the 2 s the simulated recorder starts early; before, only the 108 s of
    // high-resolution stretches came out.
    expect((await probe(file)).duration).toBeCloseTo(6 * 60 + 2, 0);
    expect(readdirSync(dirname(file))).toEqual([basename(file)]);
  }, 120_000);

  it("keep a stretch the recorder only has in low resolution", async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const [, b] = rec.find(([x, y]) => y - x >= 12 * 60_000)!, startMs = b - 11 * 60_000, endMs = b - 30_000;
    const real = f.adapter.exportClip.bind(f.adapter), { NoRecordingError } = await import("@/server/protect/types");
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => s0 === startMs + 5 * 60_000 && o?.quality === "focus" ? Promise.reject(new NoRecordingError()) : real(id, s0, e0, dest, o));
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs, endMs } })).data;
    await wait(async () => (await call(f.u.front, "GET", `/exports/${id}`)).data.status !== "running", 90_000);
    expect((await call(f.u.front, "GET", `/exports/${id}`)).data.status).toBe("ready");
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    const { probe, videoSizes } = await import("@/server/protect/ffmpeg");
    expect((await videoSizes(file)).sizes).toEqual([{ w: 1280, h: 720 }]);
    expect((await probe(file)).duration).toBeCloseTo((endMs - startMs) / 1000, 0);
  }, 120_000);
});

describe("clip exports when the recorder fails part of the clip", () => {
  const setup = async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const rec = (await call(f.u.front, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`)).data.ranges as [number, number][];
    const [, b] = rec.find(([x, y]) => y - x >= 12 * 60_000)!, startMs = b - 11 * 60_000, endMs = b - 30_000;
    f.s.recordings.retryDelaysMs = [10, 10];
    const real = f.adapter.exportClip.bind(f.adapter), types = await import("@/server/protect/types");
    return { cam, startMs, endMs, middle: startMs + 5 * 60_000, real, types };
  };
  const run = async (cam: string, startMs: number, endMs: number) => {
    const { id } = (await call(f.u.front, "POST", "/exports", { body: { cameraId: cam, startMs, endMs } })).data;
    await wait(async () => (await call(f.u.front, "GET", `/exports/${id}`)).data.status !== "running", 90_000);
    const j = (await call(f.u.front, "GET", `/exports/${id}`)).data;
    const file = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!.filePath!;
    return { j, file };
  };

  it("tries a piece again and keeps all of it when the recorder recovers", async () => {
    const { cam, startMs, endMs, middle, real, types } = await setup();
    let fails = 2;
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => s0 === middle && fails > 0 ? (fails--, Promise.reject(new types.RecorderBusyError(503))) : real(id, s0, e0, dest, o));
    const { j, file } = await run(cam, startMs, endMs);
    expect(fails).toBe(0);
    expect(j.status).toBe("ready"); expect(j.gap).toBeNull();
    expect(j.durationMs / 1000).toBeCloseTo((endMs - startMs) / 1000, 0);
    const { probe } = await import("@/server/protect/ffmpeg");
    expect((await probe(file)).duration).toBeCloseTo((endMs - startMs) / 1000, 0);
  }, 120_000);

  it("says time is missing because the recorder was busy when a piece keeps failing", async () => {
    const { cam, startMs, endMs, middle, real, types } = await setup();
    let tries = 0;
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => s0 === middle ? (tries++, Promise.reject(new types.RecorderBusyError(500))) : real(id, s0, e0, dest, o));
    const { j } = await run(cam, startMs, endMs);
    expect(tries).toBe(6); // three tries on the high channel, then three on the low one
    expect(j.status).toBe("ready"); expect(j.gap).toBe("busy");
    expect(j.durationMs / 1000).toBeCloseTo((endMs - startMs - 5 * 60_000) / 1000, 0);
  }, 120_000);

  it("says time wasn't recorded when the recorder has nothing for a piece, without retrying", async () => {
    const { cam, startMs, endMs, middle, real, types } = await setup();
    let tries = 0;
    vi.spyOn(f.adapter, "exportClip").mockImplementation((id, s0, e0, dest, o) => s0 === middle ? (tries++, Promise.reject(new types.NoRecordingError())) : real(id, s0, e0, dest, o));
    const { j } = await run(cam, startMs, endMs);
    expect(tries).toBe(2); // once per channel
    expect(j.status).toBe("ready"); expect(j.gap).toBe("unrecorded");
  }, 120_000);

  it("fails with a busy message when no piece could be exported", async () => {
    const { cam, startMs, endMs, types } = await setup();
    vi.spyOn(f.adapter, "exportClip").mockImplementation(() => Promise.reject(new types.RecorderBusyError(503)));
    const { j } = await run(cam, startMs, endMs);
    expect(j.status).toBe("failed"); expect(j.error).toBe("The recorder is busy. Try again in a few minutes.");
  }, 60_000);
});

describe("clip exports made during See as staff", () => {
  it("are refused and cleaned up once that preview ends, even through another live preview of the same person", async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const pv = (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } })).data.token as string;
    const other = (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } })).data.token as string; // a second tab
    const rec = (await call(f.u.admin, "GET", `/cameras/${cam}/recordings?from=${t - 3600e3}&to=${t}`, { preview: pv })).data.ranges as [number, number][];
    const start = rec[rec.length - 1][1] - 60_000;
    const { id } = (await call(f.u.admin, "POST", "/exports", { preview: pv, body: { cameraId: cam, startMs: start, endMs: start + 5000 } })).data;
    await wait(async () => (await call(f.u.admin, "GET", `/exports/${id}`, { preview: pv })).data.status === "ready");
    const job = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!;
    expect(job).toMatchObject({ subjectId: f.u.front, previewId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await call(f.u.admin, "GET", `/exports/${id}/download`, { preview: pv })).status).toBe(200);
    expect((await call(f.u.admin, "GET", `/exports/${id}/download`)).status).toBe(404); // outside the preview the administrator is another subject
    expect(existsSync(job.filePath!)).toBe(true);

    expect((await call(f.u.admin, "DELETE", "/preview", { preview: pv })).status).toBeLessThan(300);
    expect((await call(f.u.admin, "GET", `/exports/${id}/download`, { preview: pv })).status).toBe(409); // the preview itself is over
    expect((await call(f.u.admin, "GET", `/exports/${id}`, { preview: other })).status).toBe(404);
    expect((await call(f.u.admin, "GET", `/exports/${id}/download`, { preview: other })).status).toBe(404);
    await wait(async () => !existsSync(job.filePath!), 2000);
    await wait(async () => !f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get(), 2000);
    expect((await call(f.u.admin, "GET", "/cameras", { preview: other })).status).toBe(200); // the other preview is untouched
  });
  it("are cleaned up when the preview times out with no request to notice it", async () => {
    const cam = f.cam["Loading Dock"], t = Date.now() - 2 * 3600e3;
    const pv = (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } })).data.token as string;
    const { id } = (await call(f.u.admin, "POST", "/exports", { preview: pv, body: { cameraId: cam, startMs: t, endMs: t + 5000 } })).data;
    await wait(async () => (await call(f.u.admin, "GET", `/exports/${id}`, { preview: pv })).data.status !== "running");
    const job = f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get()!;
    f.db.update(schema.previewContexts).set({ expiresAt: Date.now() - 1 }).where(eq(schema.previewContexts.id, job.previewId!)).run();
    f.s.access.expireDue(); // the revocation timer
    await wait(async () => !f.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get(), 2000);
    expect(existsSync(job.filePath!)).toBe(false);
  });
});

// The relay here is the in-memory one from the fixture. It asks the gateway (`Media.admit`) before admitting any reader.
describe("media tickets and active-stream revocation", () => {
  const whep = (userId: string, camera: string, q = "") => call(userId, "POST", `/media/live/${f.cam[camera]}/whep${q}`, { raw: "v=0 offer" });
  const hls = (userId: string | null, camera: string, file: string) => call(userId, "GET", `/media/live/${f.cam[camera]}/hls/wall/${file}`);
  const kicked = (id: string, ms = 2000) => wait(async () => f.relay.kicked.includes(id), ms); // well inside the 30 s bound

  it("admits a reader only with a fresh ticket for the right path, once", async () => {
    const cam = f.cam["Front Entrance"];
    const r = await whep(f.u.front, "Front Entrance", "?q=wall");
    expect(r.status).toBe(201); expect(r.res.headers.get("location")).toMatch(/^\/api\/media\/live\/whep\//);
    expect(await r.res.text()).toBe("v=0 answer");
    expect(f.relay.tickets).toHaveLength(1);
    const admit = (o: { stream?: string; ticket: string; kind?: "webrtc" | "hls" }) => f.s.media.admit({ kind: "webrtc", stream: `c_${cam}_wall`, id: "mtx-x", ...o });
    expect(admit({ ticket: f.relay.tickets[0] })).toBe(false); // single use: replay by anyone fails
    expect(admit({ ticket: "guess" })).toBe(false);
    expect(admit({ ticket: "" })).toBe(false); // direct, unauthenticated access to the relay
    // How MediaMTX's own traffic and other protocols are answered is pinned in tests/mediamtx.test.ts.
    // The WHEP resource belongs to the session that created it.
    const secret = r.res.headers.get("location")!.split("/").pop();
    expect((await call(f.u.sec, "DELETE", `/media/live/whep/${secret}`)).status).toBe(404);
    expect((await call(f.u.front, "PATCH", `/media/live/whep/${secret}`, { raw: "a=candidate" })).status).toBe(204);
    expect((await call(f.u.front, "DELETE", `/media/live/whep/${secret}`)).status).toBe(200);
    expect((await call(f.u.front, "PATCH", `/media/live/whep/${secret}`, { raw: "a=candidate" })).status).toBe(404); // gone after teardown
    expect(f.relay.ids("webrtc")).toEqual([]);
  });
  it("limits distinct streams per session, not relay readers, and frees a slot when WebRTC is torn down", async () => {
    (config() as { MAX_WALL_STREAMS: number }).MAX_WALL_STREAMS = -1; // a limit of 2 streams
    const hlsQ = (camera: string, q: string) => call(f.u.front, "GET", `/media/live/${f.cam[camera]}/hls/${q}/index.m3u8`);
    expect((await whep(f.u.front, "Front Entrance", "?q=wall")).status).toBe(201);
    const dock = await whep(f.u.front, "Loading Dock", "?q=wall");
    expect(dock.status).toBe(201);
    expect((await hlsQ("Front Entrance", "focus")).status).toBe(429); // a third stream
    // More readers for a stream already open are not more streams: a retry, or the HLS fallback.
    expect((await whep(f.u.front, "Front Entrance", "?q=wall")).status).toBe(201);
    expect((await hlsQ("Loading Dock", "wall")).status).toBe(200);
    const secret = dock.res.headers.get("location")!.split("/").pop();
    expect((await call(f.u.front, "DELETE", `/media/live/whep/${secret}`)).status).toBe(200);
    expect((await hlsQ("Front Entrance", "focus")).status).toBe(429); // the dock's HLS reader still holds that slot
  });
  it("frees a stream slot as soon as its WebRTC session is torn down, without waiting for a sweep", async () => {
    (config() as { MAX_WALL_STREAMS: number }).MAX_WALL_STREAMS = -1; // a limit of 2 streams
    expect((await whep(f.u.front, "Front Entrance", "?q=wall")).status).toBe(201);
    const dock = await whep(f.u.front, "Loading Dock", "?q=wall");
    expect((await hls(f.u.front, "Front Entrance", "index.m3u8")).status).toBe(200); // same stream as an open one
    expect((await call(f.u.front, "GET", `/media/live/${f.cam["Loading Dock"]}/hls/focus/index.m3u8`)).status).toBe(429);
    expect((await call(f.u.front, "DELETE", `/media/live/whep/${dock.res.headers.get("location")!.split("/").pop()}`)).status).toBe(200);
    expect((await call(f.u.front, "GET", `/media/live/${f.cam["Loading Dock"]}/hls/focus/index.m3u8`)).status).toBe(200);
  });
  it("releases an HLS stream's slot as soon as the player stops it, and only that session's", async () => {
    (config() as { MAX_WALL_STREAMS: number }).MAX_WALL_STREAMS = -1; // a limit of 2 streams
    const playlist = (u: string, camera: string, q = "wall") => call(u, "GET", `/media/live/${f.cam[camera]}/hls/${q}/index.m3u8`);
    expect((await playlist(f.u.front, "Front Entrance")).status).toBe(200);
    expect((await playlist(f.u.sec, "Front Entrance")).status).toBe(200); // another person watching the same camera
    expect((await playlist(f.u.front, "Loading Dock")).status).toBe(200);
    expect((await playlist(f.u.front, "Front Entrance", "focus")).status).toBe(429); // a third stream
    const before = f.relay.ids("hls");
    expect((await call(f.u.front, "DELETE", `/media/live/${f.cam["Loading Dock"]}/hls/wall`)).status).toBe(200);
    expect(f.relay.ids("hls")).toHaveLength(before.length - 1); // that reader is gone from the relay
    expect((await playlist(f.u.front, "Front Entrance", "focus")).status).toBe(200); // the slot is free at once
    expect((await call(f.u.front, "DELETE", `/media/live/${f.cam["Front Entrance"]}/hls/wall`)).status).toBe(200);
    expect((await playlist(f.u.sec, "Front Entrance")).status).toBe(200); // the other person's stream is untouched
    expect(f.relay.kicked).toHaveLength(2);
    expect((await call(f.u.front, "DELETE", "/media/live/no-such-camera/hls/wall")).status).toBe(200); // same answer for any id
    expect((await call(f.u.front, "DELETE", `/media/live/${f.cam["Loading Dock"]}/hls/wall`, { csrf: false })).status).toBe(403);
  });
  it("tells only administrators which cameras are recording, and not while previewing as staff", async () => {
    const r = await call(f.u.admin, "GET", "/recording");
    expect(r.status).toBe(200);
    const ids = (r.data as { cameraIds: string[] }).cameraIds;
    expect(ids).toContain(f.cam["Front Entrance"]); // the mock's continuously recording camera
    expect(ids.every((id) => Object.values(f.cam).includes(id))).toBe(true);
    expect((await call(f.u.front, "GET", "/recording")).status).toBe(403);
    expect((await call(null, "GET", "/recording")).status).toBe(401);
    const pv = await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } });
    expect((await call(f.u.admin, "GET", "/recording", { preview: (pv.data as { token: string }).token })).status).toBe(403);
    expect((await call(f.u.front, "GET", "/cameras")).text).not.toMatch(/recording/i); // nothing about recording reaches staff
  });
  it("stops an active stream when the grant, the account or the session goes away", async () => {
    await whep(f.u.front, "Loading Dock"); await whep(f.u.front, "Front Entrance"); await whep(f.u.upper, "Upper Lounge");
    const [dock, entrance, lounge] = f.relay.ids("webrtc");
    const unknown = f.relay.intruder("webrtc");
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], false);
    await kicked(dock);
    await kicked(unknown); // readers Unifeye did not admit are removed
    expect(f.relay.kicked).not.toContain(entrance); expect(f.relay.kicked).not.toContain(lounge);
    f.admin.updateUser(f.actor(f.u.admin), f.u.upper, { status: "disabled" });
    await kicked(lounge);
    f.sessions.revokeUser(f.u.front, "logout");
    await kicked(entrance);
    expect((await whep(f.u.front, "Front Entrance")).status).toBe(401);
    expect(f.relay.ids("webrtc")).toEqual([]);
  });
  it("a revocation that lands while a sweep is running is swept right after it, and later ones still are", async () => {
    await whep(f.u.front, "Loading Dock"); await whep(f.u.upper, "Upper Lounge");
    const [dock, lounge] = f.relay.ids("webrtc");
    const release = f.relay.holdListing();
    const running = f.s.media.sweep(); // e.g. the timer's sweep, waiting on the relay
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], false);
    await new Promise((r) => setTimeout(r, 20)); // the signal's sweep finds one already running
    expect(f.relay.kicked).toEqual([]);
    release();
    await running;
    await kicked(dock);
    f.sessions.revokeUser(f.u.upper, "logout");
    await kicked(lounge);
  });

  it("serves the HLS fallback through the gateway, asking the hook for every file", async () => {
    const list = await hls(f.u.front, "Front Entrance", "index.m3u8");
    expect(list.status).toBe(200);
    expect(list.res.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(list.res.headers.get("cache-control")).toBe("no-store");
    expect(list.res.headers.get("set-cookie")).toBeNull(); expect(list.res.headers.get("location")).toBeNull();
    expect(await list.res.text()).toBe(HLS_PLAYLIST);
    const seg = await hls(f.u.front, "Front Entrance", "seg1.mp4");
    expect(seg.status).toBe(200); expect(seg.res.headers.get("content-type")).toBe("video/mp4");
    expect((await seg.res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect(f.relay.tickets).toHaveLength(2); expect(f.relay.tickets[1]).toBe(f.relay.tickets[0]); // one reader, admitted twice
    expect(f.relay.ids("hls")).toHaveLength(1);
    expect((await hls(f.u.front, "Front Entrance", "missing.mp4")).status).toBe(404);
    // An HLS ticket is bound to its transport and path, and nobody else gets in on this reader.
    const cam = f.cam["Front Entrance"], ticket = f.relay.tickets[0];
    expect(f.s.media.admit({ kind: "webrtc", stream: `c_${cam}_wall`, ticket, id: "x" })).toBe(false);
    expect(f.s.media.admit({ kind: "hls", stream: `c_${cam}_focus`, ticket, id: "x" })).toBe(false);
    expect((await hls(null, "Front Entrance", "seg1.mp4")).status).toBe(401);
    expect((await hls(f.u.nobody, "Front Entrance", "seg1.mp4")).status).toBe(404);
    expect(f.relay.ids("hls")).toHaveLength(1);
  });
  it("refuses HLS files once access is revoked, without asking the relay", async () => {
    expect((await hls(f.u.front, "Loading Dock", "index.m3u8")).status).toBe(200);
    const asked = f.relay.tickets.length;
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], false);
    const r = await hls(f.u.front, "Loading Dock", "seg1.mp4");
    expect(r.status).toBe(404); expect(r.text).toBe((await hls(f.u.front, "Server Closet", "seg1.mp4")).text);
    expect((await hls(f.u.front, "Front Entrance", "index.m3u8")).status).toBe(200); // other cameras are unaffected
    f.sessions.revokeUser(f.u.front, "logout");
    expect((await hls(f.u.front, "Front Entrance", "seg1.mp4")).status).toBe(401);
    expect(f.relay.tickets).toHaveLength(asked + 1);
  });
  it("the sweep kicks HLS and WebRTC readers whose access is gone and leaves the others alone", async () => {
    await hls(f.u.front, "Loading Dock", "index.m3u8"); await hls(f.u.front, "Front Entrance", "index.m3u8"); await hls(f.u.upper, "Upper Lounge", "index.m3u8");
    await whep(f.u.front, "Loading Dock"); await whep(f.u.front, "Front Entrance");
    const [hlsDock, hlsEntrance, hlsLounge] = f.relay.ids("hls"), [rtcDock, rtcEntrance] = f.relay.ids("webrtc");
    expect(await f.s.media.sweep()).toEqual({ kicked: 0 }); // nothing changed: everyone stays
    expect(f.relay.kicked).toEqual([]);
    expect((await call(null, "GET", "/ready")).data.liveSessions).toBe(5);

    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], false);
    await kicked(hlsDock); await kicked(rtcDock);
    await f.s.media.sweep();
    expect([...f.relay.kicked].sort()).toEqual([hlsDock, rtcDock].sort());
    expect(f.relay.ids("hls")).toEqual([hlsEntrance, hlsLounge]); expect(f.relay.ids("webrtc")).toEqual([rtcEntrance]);
    // The gateway's HLS state for that camera went with it: access given back starts over with a new ticket.
    f.admin.setGrant(f.actor(f.u.admin), { userId: f.u.front }, f.cam["Loading Dock"], true);
    const before = new Set(f.relay.tickets);
    expect((await hls(f.u.front, "Loading Dock", "index.m3u8")).status).toBe(200);
    expect(before.has(f.relay.tickets.at(-1)!)).toBe(false);

    f.sessions.revokeUser(f.u.upper, "logout"); // a session ending stops HLS too
    await kicked(hlsLounge);
    expect(f.relay.kicked).not.toContain(hlsEntrance); expect(f.relay.kicked).not.toContain(rtcEntrance);
  });
  it("kicks a reader the relay admitted without Unifeye, on either transport", async () => {
    await whep(f.u.front, "Front Entrance");
    const a = f.relay.intruder("hls"), b = f.relay.intruder("webrtc");
    expect(await f.s.media.sweep()).toEqual({ kicked: 2 });
    expect([...f.relay.kicked].sort()).toEqual([a, b].sort());
    expect(f.relay.ids("webrtc")).toHaveLength(1);
  });
  it("answers 503 relay_unavailable while the relay is down, and recovers", async () => {
    const live = await whep(f.u.front, "Front Entrance");
    const secret = live.res.headers.get("location")!.split("/").pop();
    expect((await hls(f.u.front, "Loading Dock", "index.m3u8")).status).toBe(200);
    f.relay.down = true;
    for (const r of [await whep(f.u.front, "Loading Dock"), await hls(f.u.front, "Front Entrance", "index.m3u8"), await hls(f.u.front, "Loading Dock", "seg1.mp4"), await call(f.u.front, "PATCH", `/media/live/whep/${secret}`, { raw: "a=candidate" }), await call(f.u.front, "DELETE", `/media/live/whep/${secret}`)]) {
      expect(r.status).toBe(503); expect(r.data.error).toBe("relay_unavailable");
    }
    expect((await whep(f.u.front, "Server Closet")).status).toBe(404); // still nothing to learn about forbidden cameras
    await expect(f.s.media.sweep()).resolves.toEqual({ kicked: 0 }); // a sweep survives the outage
    f.relay.down = false;
    expect((await whep(f.u.front, "Loading Dock")).status).toBe(201);
    expect((await hls(f.u.front, "Front Entrance", "index.m3u8")).status).toBe(200);
  });
  it("/ready reports whether the relay is reachable", async () => {
    const up = await call(null, "GET", "/ready");
    expect(up.status).toBe(200); expect(up.data.relay).toBe(true);
    f.relay.down = true;
    const down = await call(null, "GET", "/ready");
    expect(down.status).toBe(200); expect(down.data.relay).toBe(false); expect(down.data.database).toBe(true);
  });
});

describe("See as staff (authorization preview)", () => {
  const start = async () => (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.sec } })).data.token as string;
  it("shows the subject's cameras, views and landing while the administrator stays the actor", async () => {
    const before = f.policy.user(f.u.sec)!;
    const pv = await start();
    const me = (await call(f.u.admin, "GET", "/me", { preview: pv })).data;
    expect(me.user.id).toBe(f.u.admin); expect(me.preview.subject.id).toBe(f.u.sec); expect(me.isAdmin).toBe(false);
    expect(f.views.get(me.landing.viewId)!.name).toBe("Perimeter");
    const cams = (await call(f.u.admin, "GET", "/cameras", { preview: pv })).data.cameras.map((c: { name: string }) => c.name);
    expect(cams).toEqual(f.names(f.u.sec));
    // The administrator's own access does not leak into the preview, including on media routes.
    expect((await call(f.u.admin, "GET", `/cameras/${f.cam["Server Closet"]}/snapshot`, { preview: pv })).status).toBe(404);
    expect((await call(f.u.admin, "GET", `/cameras/${f.cam["Server Closet"]}/snapshot?pv=${pv}`)).status).toBe(404);
    expect((await call(f.u.admin, "GET", `/cameras/${f.cam["Server Closet"]}/snapshot`)).status).toBe(200);
    const after = f.policy.user(f.u.sec)!;
    expect(after.lastLoginAt).toBe(before.lastLoginAt); expect(after.version).toBe(before.version);
    expect(f.db.select().from(schema.sessions).all().filter((x) => x.userId === f.u.sec)).toHaveLength(0); // no session for the subject
  });
  it("blocks every mutation and all administration during preview", async () => {
    const pv = await start();
    for (const [m, p, b] of [["PUT", "/preferences", { key: "cols", value: 4 }], ["POST", "/views", { name: "x", type: "dynamic" }], ["PUT", "/defaults", { scope: "personal", viewId: null }], ["PUT", "/admin/grants", { userId: f.u.sec, cameraId: f.cam["Server Closet"], on: true }], ["GET", "/admin/overview", undefined], ["POST", "/preview", { userId: f.u.front }]] as const)
      expect((await call(f.u.admin, m, p, { body: b, preview: pv })).status, `${m} ${p}`).toBe(403);
    expect(f.db.select().from(schema.userPreferences).all()).toHaveLength(0);
  });
  it("rejects forged, foreign and expired contexts instead of falling back to administrator access", async () => {
    const pv = await start();
    expect((await call(f.u.admin, "GET", "/cameras", { preview: "forged-token" })).data.error).toBe("preview_ended");
    expect((await call(f.u.front, "GET", "/cameras", { preview: pv })).status).toBe(409); // another user's session
    expect((await call(f.u.admin, "GET", "/cameras", { preview: pv, session: sess(f.u.admin, true) })).status).toBe(409); // same admin, different session
    expect((await call(f.u.front, "POST", "/preview", { body: { userId: f.u.sec } })).status).toBe(403); // staff cannot start one
    expect((await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.admin } })).status).toBe(403); // only staff can be previewed
    f.db.update(schema.previewContexts).set({ expiresAt: Date.now() - 1 }).run();
    expect((await call(f.u.admin, "GET", "/cameras", { preview: pv })).status).toBe(409);
  });
  it("keeps two tabs with different subjects apart", async () => {
    const a = await start(), b = (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } })).data.token;
    const names = async (pv: string) => (await call(f.u.admin, "GET", "/cameras", { preview: pv })).data.cameras.map((c: { name: string }) => c.name);
    expect(await names(a)).toEqual(f.names(f.u.sec)); expect(await names(b)).toEqual(f.names(f.u.front)); expect(await names(a)).toEqual(f.names(f.u.sec));
  });
  it("ends when the subject is disabled or the administrator loses the role, and audits both identities", async () => {
    const pv = await start();
    await call(f.u.admin, "GET", "/cameras", { preview: pv });
    f.db.update(schema.users).set({ status: "disabled" }).where(eq(schema.users.id, f.u.sec)).run();
    f.policy.invalidate();
    expect((await call(f.u.admin, "GET", "/cameras", { preview: pv })).status).toBe(409);
    const pv2 = (await call(f.u.admin, "POST", "/preview", { body: { userId: f.u.front } })).data.token;
    await call(f.u.admin, "DELETE", "/preview", { preview: pv2 });
    expect((await call(f.u.admin, "GET", "/cameras", { preview: pv2 })).status).toBe(409);
    const log = f.db.select().from(schema.auditLog).all();
    const startRow = log.find((r) => r.action === "preview.start" && r.outcome === "ok")!;
    expect(startRow.actorId).toBe(f.u.admin); expect(startRow.previewSubjectId).toBe(f.u.sec);
    expect(log.some((r) => r.action === "preview.end" && r.previewSubjectId === f.u.sec)).toBe(true);
    expect(log.some((r) => r.action === "preview.exit" && r.previewSubjectId === f.u.front)).toBe(true);
    expect(log.some((r) => r.action === "preview.start" && r.outcome === "denied")).toBe(false);
  });
});

describe("rate limits", () => {
  const from = (address: string) => ({ "x-forwarded-for": address });
  const statuses = async (n: number, fn: () => Promise<{ status: number }>) => { const s = new Set<number>(); for (let i = 0; i < n; i++) s.add((await fn()).status); return [...s]; };
  const playlist = (userId: string, address: string) => call(userId, "GET", `/media/live/${f.cam["Front Entrance"]}/hls/wall/index.m3u8`, { headers: from(address) });

  it("lets a full wall play over HLS: well past the old 600 a minute, in a budget of its own", async () => {
    // Nine tiles at about 60 requests a minute each, plus still images for the rest of the wall.
    expect(await statuses(700, () => playlist(f.u.front, "198.51.100.10"))).toEqual([200]);
    expect((await call(f.u.front, "GET", `/cameras/${f.cam["Front Entrance"]}/snapshot`, { headers: from("198.51.100.10") })).status).toBe(200);
  });
  it("counts signed-in requests per session, so people behind one address each get the full limit", async () => {
    (config() as { MAX_WALL_STREAMS: number }).MAX_WALL_STREAMS = -1; // 2 streams, so 240 HLS requests a minute
    expect(await statuses(240, () => playlist(f.u.front, "198.51.100.11"))).toEqual([200]);
    expect((await playlist(f.u.front, "198.51.100.11")).status).toBe(429);
    expect((await playlist(f.u.front, "198.51.100.12")).status).toBe(429); // a new address does not reset a session
    expect((await playlist(f.u.sec, "198.51.100.11")).status).toBe(200); // someone else at the same address
    expect((await call(f.u.front, "GET", "/me", { headers: from("198.51.100.11") })).status).toBe(200); // other routes keep their own budget
  });
  it("counts requests without a valid session per address, without blocking people signed in there", async () => {
    expect(await statuses(600, () => call(null, "GET", "/me", { headers: from("198.51.100.13") }))).toEqual([401]);
    expect((await call(null, "GET", "/me", { headers: from("198.51.100.13") })).status).toBe(429);
    expect((await call(f.u.front, "GET", "/me", { headers: from("198.51.100.13") })).status).toBe(200);
    expect((await call(null, "GET", "/me", { headers: from("198.51.100.14") })).status).toBe(401);
  });
  it("takes the client address from the last X-Forwarded-For entry, so a client cannot pick a fresh one", async () => {
    const signIn = (i: number, real: string) => call(null, "GET", "/auth/login", { headers: from(`203.0.113.${i % 250}, ${real}`) });
    let i = 0;
    expect(await statuses(30, () => signIn(++i, "198.51.100.15"))).not.toContain(429); // a different first entry every time
    expect((await signIn(7, "198.51.100.15")).status).toBe(429);
    expect((await signIn(7, "198.51.100.16")).status).not.toBe(429);
  });
});
