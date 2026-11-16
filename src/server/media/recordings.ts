import { and, eq, inArray, lt } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { audit } from "../audit";
import type { Access, CameraGrant } from "../authz/access";
import { subjectOf, type Actor } from "../authz/actor";
import type { Policy } from "../authz/policy";
import { config } from "../config";
import { schema, type Db } from "../db";
import { audioEnvelope, probe } from "../protect/ffmpeg";
import { NoRecordingError, type ProtectAdapter } from "../protect/types";
import { badRequest, HttpError, log, newId, notFound } from "../util";
import { alignSpans, type Span } from "./align";

/** What the player needs to know about a window. Overlay spans are in seconds of media time. */
export interface WindowInfo { startMs: number; endMs: number; leadMs: number; overlay: Span[] }
export interface PlaybackWindow { info: WindowInfo; base: string; high: string | null }

/** How long a finished clip stays downloadable. */
const EXPORT_KEEP = 10 * 60_000;
/** The longest a clip may take to prepare before it is dropped: generous, since the recorder builds long clips slowly. */
const prepTime = (lenMs: number) => 10 * 60_000 + lenMs;

const fmtLimit = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600} hour${sec === 3600 ? "" : "s"}` : sec % 60 === 0 ? `${sec / 60} minutes` : `${sec} seconds`);

/** Serves a local file with single-range support (what <video> needs to seek inside a window). */
export async function fileResponse(path: string, req: Request, type: string, extra: Record<string, string> = {}): Promise<Response> {
  const size = (await stat(path)).size;
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, no-store", ...extra };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (!m || (!m[1] && !m[2])) return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, { status: 200, headers: { ...base, "content-length": String(size) } });
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
  return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
}

/**
 * Historical playback and clip export.
 *
 * Playback never downloads hours of video. Time is cut into fixed windows (PLAYBACK_WINDOW_SECONDS,
 * default 60 s, aligned to the epoch). A seek to time T fetches only the window containing T from
 * the recorder as a short MP4, caches it on disk, and the player starts at offset T - windowStart.
 * The player buffers the next window while the current one plays and swaps it in when it ends.
 * Exports start on a keyframe, so a window's file can begin a few seconds early; `WindowInfo.leadMs`
 * says by how much, so the player can map media time to wall-clock time and hand over exactly at the
 * window's end. Adaptive recordings get a high-resolution overlay (see `build`). The cache is bounded in size and age.
 * An obsolete seek cancels its export when nobody else is waiting for that window.
 */
export class Recordings {
  private inflight = new Map<string, { p: Promise<PlaybackWindow>; ac: AbortController; waiters: number }>();
  private jobs = new Map<string, AbortController>();
  constructor(private db: Db, private policy: Policy, private access: Access, private adapter: () => ProtectAdapter) {}

  private dir(sub: "playback" | "exports") { return join(config().MEDIA_CACHE_DIR, sub); }

  async ranges(a: Actor, cameraId: string, fromMs: number, toMs: number) {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    if (!(toMs > fromMs) || toMs - fromMs > 8 * 864e5) throw badRequest("Invalid time range");
    return this.adapter().recordingRanges(cam.protectId, fromMs, Math.min(toMs, Date.now()));
  }

  /**
   * The playback window containing `tMs`, fetched and cached if needed: a base file that covers the
   * window, and for adaptive recordings an overlay file with the high-resolution stretches and where
   * they sit in the base (see `build`).
   */
  async window(a: Actor, cameraId: string, tMs: number, signal?: AbortSignal): Promise<PlaybackWindow> {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    const W = config().PLAYBACK_WINDOW_SECONDS * 1000, now = Date.now();
    if (!Number.isFinite(tMs) || tMs > now - 3000 || tMs < now - 400 * 864e5) throw new HttpError(404, "no_recording", "Nothing recorded at this time");
    const startMs = Math.floor(tMs / W) * W, endMs = Math.min(startMs + W, now - 2000);
    const complete = endMs === startMs + W;
    const key = `${cameraId}_${startMs}_${complete ? "full" : Math.floor(endMs / 10_000)}`, stem = join(this.dir("playback"), `${key}.v2`);
    const cached = await this.cached(stem);
    if (cached) return cached;
    let f = this.inflight.get(key);
    if (!f) {
      const ac = new AbortController();
      const p = this.build(cam.protectId, startMs, endMs, stem, ac.signal);
      f = { p, ac, waiters: 0 };
      this.inflight.set(key, f);
      p.catch(() => {}).finally(() => this.inflight.delete(key));
    }
    const entry = f;
    entry.waiters++;
    const onAbort = () => { if (--entry.waiters <= 0) entry.ac.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await entry.p;
    } catch (e) {
      if (e instanceof NoRecordingError || (e as Error)?.name === "NoRecordingError") throw new HttpError(404, "no_recording", "Nothing recorded at this time");
      if (signal?.aborted) throw new HttpError(499, "cancelled");
      log("warn", "playback window failed", { error: e });
      throw new HttpError(503, "nvr_unavailable");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** A complete cached window, or null. Housekeeping evicts files one by one, so every part is checked. */
  private async cached(stem: string): Promise<PlaybackWindow | null> {
    try {
      const info = JSON.parse(await readFile(`${stem}.json`, "utf8")) as WindowInfo, high = info.overlay.length ? `${stem}.hi.mp4` : null;
      await Promise.all([stat(`${stem}.mp4`), high && stat(high)]);
      const t = new Date();
      for (const p of [`${stem}.json`, `${stem}.mp4`, high]) if (p) void utimes(p, t, t).catch(() => {});
      return { info, base: `${stem}.mp4`, high };
    } catch { return null; }
  }

  /**
   * Exports a window. Normally that is one channel 0 export. With adaptive recording, a window that
   * contains motion exports from channel 0 as only its high-resolution stretch, so when that export
   * is more than a second shorter than the window, the low-resolution channel is exported too. The low one
   * becomes the base and the high one an overlay, placed by matching their audio. If the audio cannot
   * place it, the window plays in low resolution rather than at the wrong moment.
   *
   * `leadMs` is how far before the window start the base begins: the recorder starts an export on the
   * keyframe before the requested time, which can be a few seconds early.
   */
  private async build(protectId: string, startMs: number, endMs: number, stem: string, signal: AbortSignal): Promise<PlaybackWindow> {
    await mkdir(this.dir("playback"), { recursive: true, mode: 0o700 });
    const tmp = `${stem}.${newId()}`, focus = `${tmp}.f.part`, wall = `${tmp}.w.part`, span = (endMs - startMs) / 1000;
    try {
      const ad = this.adapter();
      await ad.exportClip(protectId, startMs, endMs, focus, { quality: "focus", signal });
      const f = await probe(focus, signal).catch(() => null);
      let base = focus, baseInfo = f, high: string | null = null, overlay: Span[] = [];
      if (f && f.duration < span - 1) {
        const w = await ad.exportClip(protectId, startMs, endMs, wall, { quality: "wall", signal }).then(() => probe(wall, signal)).catch((e) => { if (signal.aborted) throw e; return null; });
        if (w && w.duration > f.duration + 2 && w.width < f.width) {
          base = wall; baseInfo = w;
          if (f.audio && w.audio) overlay = alignSpans(await audioEnvelope(focus, signal), await audioEnvelope(wall, signal));
          if (overlay.length) high = focus;
          else log("info", "adaptive playback window shown in low resolution: the high-resolution part could not be placed", { protectId, startMs });
        }
      }
      const info: WindowInfo = { startMs, endMs, leadMs: baseInfo ? Math.min(10_000, Math.max(0, Math.round(baseInfo.duration * 1000 - (endMs - startMs)))) : 0, overlay };
      await rename(base, `${stem}.mp4`);
      if (high) await rename(high, `${stem}.hi.mp4`);
      await writeFile(`${tmp}.json.part`, JSON.stringify(info), { mode: 0o600 });
      await rename(`${tmp}.json.part`, `${stem}.json`);
      return { info, base: `${stem}.mp4`, high: high && `${stem}.hi.mp4` };
    } finally {
      await Promise.all([focus, wall, `${tmp}.json.part`].map((p) => rm(p, { force: true })));
    }
  }

  // ---- clip export jobs -------------------------------------------------
  /** The grant a job was created under, as stored in its row. */
  private grantOf(j: typeof schema.exportJobs.$inferSelect): CameraGrant {
    return { sessionId: j.sessionId, subjectId: j.subjectId, previewId: j.previewId ?? undefined, cameraId: j.cameraId };
  }
  createExport(a: Actor, cameraId: string, startMs: number, endMs: number) {
    const cam = this.policy.camera(subjectOf(a), cameraId), max = config().CLIP_MAX_SECONDS * 1000;
    if (!(endMs > startMs) || endMs - startMs > max || endMs > Date.now()) throw badRequest(`Clips can be up to ${fmtLimit(config().CLIP_MAX_SECONDS)} long.`);
    // A long clip ties up the recorder for minutes, so each session prepares at most two at a time.
    const running = this.db.select({ id: schema.exportJobs.id }).from(schema.exportJobs).where(and(eq(schema.exportJobs.sessionId, a.sessionId), eq(schema.exportJobs.status, "running"))).all();
    if (running.filter((j) => this.jobs.has(j.id)).length >= 2) throw new HttpError(429, "too_many_exports", "Two clips are already being prepared. Wait for one to finish.");
    const id = newId(), t = Date.now(), file = join(this.dir("exports"), `${id}.mp4`), g = this.access.grant(a, cameraId);
    this.db.insert(schema.exportJobs).values({ id, sessionId: g.sessionId, subjectId: g.subjectId, previewId: g.previewId ?? null, cameraId: g.cameraId, startMs, endMs, status: "running", progress: 10, filePath: file, createdAt: t, expiresAt: t + EXPORT_KEEP + prepTime(endMs - startMs) }).run();
    audit(this.db, { actorId: a.userId, previewSubjectId: a.preview?.subjectId, action: "clip.export", targetType: "camera", targetId: cameraId, requestId: a.requestId, ip: a.ip, detail: { startMs, endMs } });
    const ac = new AbortController();
    this.jobs.set(id, ac);
    const set = (v: Partial<typeof schema.exportJobs.$inferInsert>) => this.db.update(schema.exportJobs).set(v).where(and(eq(schema.exportJobs.id, id), eq(schema.exportJobs.status, "running"))).run();
    void (async () => {
      try {
        await mkdir(this.dir("exports"), { recursive: true, mode: 0o700 });
        await this.adapter().exportClip(cam.protectId, startMs, endMs, file, { quality: "focus", signal: ac.signal });
        set({ status: "ready", progress: 100, expiresAt: Date.now() + EXPORT_KEEP });
      } catch (e) {
        await rm(file, { force: true });
        set({ status: ac.signal.aborted ? "cancelled" : "failed", error: e instanceof NoRecordingError ? "Nothing was recorded during that time." : "Something went wrong. Try again." });
      } finally { this.jobs.delete(id); }
    })();
    return { id };
  }
  /** Job status. An id that belongs to another session or subject, or whose grant no longer holds (session, preview, camera), does not exist. */
  exportJob(a: Actor, id: string) {
    const j = this.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, id)).get();
    if (!j || !this.access.heldBy(this.grantOf(j), a) || (Date.now() > j.expiresAt && j.status !== "running")) throw notFound();
    return j;
  }
  cancelExport(a: Actor, id: string) {
    const j = this.exportJob(a, id);
    this.jobs.get(id)?.abort();
    this.db.update(schema.exportJobs).set({ status: "cancelled" }).where(and(eq(schema.exportJobs.id, id), inArray(schema.exportJobs.status, ["running", "queued", "ready"]))).run();
    if (j.filePath) void rm(j.filePath, { force: true });
  }
  downloadPath(a: Actor, id: string) {
    const j = this.exportJob(a, id);
    if (j.status !== "ready" || !j.filePath) throw notFound();
    return { file: j.filePath, name: `${this.policy.camera(subjectOf(a), j.cameraId).name.replace(/[^\w.-]+/g, "_")}_${new Date(j.startMs).toISOString().replace(/[:.]/g, "-")}.mp4` };
  }

  /**
   * Removes jobs and download files that expired or whose grant no longer holds (session, preview
   * or camera access gone). Runs on every access change (subscribed in services.ts) and from `cleanup`.
   */
  async dropDeadExports() {
    const t = Date.now();
    for (const j of this.db.select().from(schema.exportJobs).all()) {
      if (t <= j.expiresAt && this.access.holds(this.grantOf(j))) continue;
      this.jobs.get(j.id)?.abort();
      if (j.filePath) await rm(j.filePath, { force: true });
      this.db.delete(schema.exportJobs).where(eq(schema.exportJobs.id, j.id)).run();
    }
    this.db.delete(schema.exportJobs).where(lt(schema.exportJobs.expiresAt, t - 864e5)).run();
  }

  /** Periodic housekeeping: dead exports, and the playback cache kept within its age and size limits. */
  async cleanup() {
    await this.dropDeadExports();
    const t = Date.now();
    const dir = this.dir("playback"), max = config().MEDIA_CACHE_MAX_MB * 1024 * 1024;
    const files: { p: string; size: number; m: number }[] = [];
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, f), s = await stat(p).catch(() => null);
      if (!s) continue;
      if (t - s.mtimeMs > (f.endsWith(".part") ? 10 * 60_000 : 6 * 36e5)) await rm(p, { force: true }); else files.push({ p, size: s.size, m: s.mtimeMs });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of files.sort((a, b) => a.m - b.m)) { if (total <= max) break; await rm(f.p, { force: true }); total -= f.size; }
    return { cacheBytes: total };
  }
}
