import { and, eq, inArray, lt } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { audit } from "../audit";
import type { Access, CameraGrant } from "../authz/access";
import { subjectOf, type Actor } from "../authz/actor";
import type { Policy } from "../authz/policy";
import { config } from "../config";
import { schema, type Db } from "../db";
import { NoRecordingError, type ProtectAdapter } from "../protect/types";
import { badRequest, HttpError, log, newId, notFound } from "../util";

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
 * The player buffers the next window while the current one plays and swaps it in when it ends. Clips start on a keyframe, so the first frame
 * can be up to one keyframe interval early; the response carries the window's real start and end so
 * the player can map media time to wall-clock time. The cache is bounded in size and age.
 * An obsolete seek cancels its export when nobody else is waiting for that window.
 */
export class Recordings {
  private inflight = new Map<string, { p: Promise<string>; ac: AbortController; waiters: number }>();
  private jobs = new Map<string, AbortController>();
  constructor(private db: Db, private policy: Policy, private access: Access, private adapter: () => ProtectAdapter) {}

  private dir(sub: "playback" | "exports") { return join(config().MEDIA_CACHE_DIR, sub); }

  async ranges(a: Actor, cameraId: string, fromMs: number, toMs: number) {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    if (!(toMs > fromMs) || toMs - fromMs > 8 * 864e5) throw badRequest("Invalid time range");
    return this.adapter().recordingRanges(cam.protectId, fromMs, Math.min(toMs, Date.now()));
  }

  /** Returns the cached window file containing `tMs`, fetching it if needed. */
  async window(a: Actor, cameraId: string, tMs: number, signal?: AbortSignal): Promise<{ file: string; startMs: number; endMs: number }> {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    const W = config().PLAYBACK_WINDOW_SECONDS * 1000, now = Date.now();
    if (!Number.isFinite(tMs) || tMs > now - 3000 || tMs < now - 400 * 864e5) throw new HttpError(404, "no_recording", "Nothing recorded at this time");
    const startMs = Math.floor(tMs / W) * W, endMs = Math.min(startMs + W, now - 2000);
    const complete = endMs === startMs + W;
    const key = `${cameraId}_${startMs}_${complete ? "full" : Math.floor(endMs / 10_000)}`, file = join(this.dir("playback"), `${key}.mp4`);
    try { await stat(file); void utimes(file, new Date(), new Date()).catch(() => {}); return { file, startMs, endMs }; } catch { /* not cached */ }
    let f = this.inflight.get(key);
    if (!f) {
      const ac = new AbortController();
      const p = (async () => {
        await mkdir(this.dir("playback"), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${newId()}.part`;
        try {
          await this.adapter().exportClip(cam.protectId, startMs, endMs, tmp, { quality: "focus", signal: ac.signal });
          const { rename } = await import("node:fs/promises");
          await rename(tmp, file);
          return file;
        } catch (e) { await rm(tmp, { force: true }); throw e; }
      })();
      f = { p, ac, waiters: 0 };
      this.inflight.set(key, f);
      p.catch(() => {}).finally(() => this.inflight.delete(key));
    }
    const entry = f;
    entry.waiters++;
    const onAbort = () => { if (--entry.waiters <= 0) entry.ac.abort(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return { file: await entry.p, startMs, endMs };
    } catch (e) {
      if (e instanceof NoRecordingError || (e as Error)?.name === "NoRecordingError") throw new HttpError(404, "no_recording", "Nothing recorded at this time");
      if (signal?.aborted) throw new HttpError(499, "cancelled");
      log("warn", "playback window failed", { error: e });
      throw new HttpError(503, "nvr_unavailable");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  // ---- clip export jobs -------------------------------------------------
  /** The grant a job was created under, as stored in its row. */
  private grantOf(j: typeof schema.exportJobs.$inferSelect): CameraGrant {
    return { sessionId: j.sessionId, subjectId: j.subjectId, previewId: j.previewId ?? undefined, cameraId: j.cameraId };
  }
  createExport(a: Actor, cameraId: string, startMs: number, endMs: number) {
    const cam = this.policy.camera(subjectOf(a), cameraId), max = config().CLIP_MAX_SECONDS * 1000;
    if (!(endMs > startMs) || endMs - startMs > max || endMs > Date.now()) throw badRequest(`Clips can be up to ${config().CLIP_MAX_SECONDS % 60 ? `${config().CLIP_MAX_SECONDS} seconds` : `${config().CLIP_MAX_SECONDS / 60} minutes`} long.`);
    const id = newId(), t = Date.now(), file = join(this.dir("exports"), `${id}.mp4`), g = this.access.grant(a, cameraId);
    this.db.insert(schema.exportJobs).values({ id, sessionId: g.sessionId, subjectId: g.subjectId, previewId: g.previewId ?? null, cameraId: g.cameraId, startMs, endMs, status: "running", progress: 10, filePath: file, createdAt: t, expiresAt: t + 10 * 60_000 }).run();
    audit(this.db, { actorId: a.userId, previewSubjectId: a.preview?.subjectId, action: "clip.export", targetType: "camera", targetId: cameraId, requestId: a.requestId, ip: a.ip, detail: { startMs, endMs } });
    const ac = new AbortController();
    this.jobs.set(id, ac);
    const set = (v: Partial<typeof schema.exportJobs.$inferInsert>) => this.db.update(schema.exportJobs).set(v).where(and(eq(schema.exportJobs.id, id), eq(schema.exportJobs.status, "running"))).run();
    void (async () => {
      try {
        await mkdir(this.dir("exports"), { recursive: true, mode: 0o700 });
        await this.adapter().exportClip(cam.protectId, startMs, endMs, file, { quality: "focus", signal: ac.signal });
        set({ status: "ready", progress: 100 });
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
