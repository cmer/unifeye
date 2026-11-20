import { and, eq, inArray, lt } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { audit } from "../audit";
import type { Access, CameraGrant } from "../authz/access";
import { subjectOf, type Actor } from "../authz/actor";
import type { Policy } from "../authz/policy";
import { config } from "../config";
import { schema, type Db } from "../db";
import { joinParts, probe } from "../protect/ffmpeg";
import { isNoRecording, isRecorderBusy, NoRecordingError, RecorderBusyError, type ProtectAdapter } from "../protect/types";
import { badRequest, HttpError, log, newId, notFound } from "../util";
import { SizeMatcher } from "./match-size";
import { fetchRecorded, fetchRecordedFile, type Entry, type ExportChannel, type ListSegments, type ListStamps, type Piece, type PieceOptions, type Recorded } from "./recorded";
import { startAfter, type Seams } from "./timeline";

/**
 * What the player needs to know about a window: the order to play its files in (`timeline.ts`),
 * whether a high-resolution file goes with the base, and the keyframes at its seams, which tell
 * whether the next window's lead repeats this one's end. `pending`: the high-resolution file is still
 * being placed, so these entries are for the base alone and fuller ones follow.
 * The player imports this type, so the two cannot drift apart.
 */
export interface WindowInfo { startMs: number; endMs: number; entries: Entry[]; high: boolean; seams: Recorded["seams"]; pending?: true }
export interface PlaybackWindow { info: WindowInfo; base: string; high: string | null }

/**
 * A window built while the recorder was failing part of the way (`Recorded.degraded`) is kept only
 * this long, so a passing hiccup is not baked into the cache: the player that asked can still load
 * its files, and anyone coming back later gets it fetched again.
 */
const DEGRADED_KEEP_MS = 2 * 60_000;
/** What is saved beside a window's files: its description, and when a degraded one is to be fetched again. */
type SavedWindow = WindowInfo & { refetchAfter?: number };

/** Clips longer than this are fetched from the recorder in pieces of this length (see `exportPieces`). */
const PIECE = 5 * 60_000;
/** A saved clip this much shorter than asked (or 1% of it, if more) is reported as missing time. */
const MISSING_MIN = 5_000;
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
 * the recorder as a short MP4, caches it on disk, and the player starts at the moment T.
 * The player buffers the next window while the current one plays and swaps it in when it ends.
 * Exports start on a keyframe, so a window's file begins with the last keyframe before the window
 * (its lead, which the window before ends with). `WindowInfo.entries` say in what order to play the
 * files and which wall-clock time each moment shows, so the player can seek to a time and hand over
 * to the next window after its lead. Adaptive recordings also get a high-resolution file (see
 * `recorded.ts`). The cache is bounded in size and age.
 * An obsolete seek cancels its export when nobody else is waiting for that window.
 */
export class Recordings {
  /** What the recorder has given since start-up (`Recorded.got`), so a later absence counts as a hiccup. */
  private known: { segments?: boolean; stamps?: boolean } = {};
  private inflight = new Map<string, { early: Promise<PlaybackWindow>; full: Promise<PlaybackWindow>; ac: AbortController; waiters: number }>();
  private jobs = new Map<string, AbortController>();
  /** Estimated time left for running clip jobs, as of `at`. */
  private etas = new Map<string, { ms: number; at: number }>();
  /** Pauses before each new try of a clip piece the recorder failed to export (`exporter`). Tests shorten them. */
  retryDelaysMs = [10_000, 30_000];
  constructor(private db: Db, private policy: Policy, private access: Access, private adapter: () => ProtectAdapter) {}

  private dir(sub: "playback" | "exports") { return join(config().MEDIA_CACHE_DIR, sub); }

  async ranges(a: Actor, cameraId: string, fromMs: number, toMs: number) {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    if (!(toMs > fromMs) || toMs - fromMs > 8 * 864e5) throw badRequest("Invalid time range");
    return this.adapter().recordingRanges(cam.protectId, fromMs, Math.min(toMs, Date.now()));
  }

  /**
   * The playback window containing `tMs`, fetched and cached if needed: a base file, for adaptive
   * recordings a high-resolution file, and the order to play them in (see `fetchRecorded`). With
   * `early`, an adaptive window answers as soon as its base is ready (`WindowInfo.pending`), so
   * playback can start while the high-resolution file is still on its way. With `files` (a player
   * loading the files of a window it already has the description of), a degraded window past its
   * time is served as it is rather than fetched again, so the files keep matching that description.
   */
  async window(a: Actor, cameraId: string, tMs: number, signal?: AbortSignal, early = false, files = false): Promise<PlaybackWindow> {
    const cam = this.policy.camera(subjectOf(a), cameraId);
    const W = config().PLAYBACK_WINDOW_SECONDS * 1000, now = Date.now();
    if (!Number.isFinite(tMs) || tMs > now - 3000 || tMs < now - 400 * 864e5) throw new HttpError(404, "no_recording", "Nothing recorded at this time");
    const startMs = Math.floor(tMs / W) * W, endMs = Math.min(startMs + W, now - 2000);
    const complete = endMs === startMs + W;
    const key = `${cameraId}_${startMs}_${complete ? "full" : Math.floor(endMs / 10_000)}`, stem = join(this.dir("playback"), `${key}.v4`);
    const cached = await this.cached(stem);
    if (cached && (!cached.stale || files)) return cached.w;
    let f = this.inflight.get(key);
    if (!f) {
      const ac = new AbortController();
      let base!: (w: PlaybackWindow) => void;
      const first = new Promise<PlaybackWindow>((r) => (base = r));
      const full = this.build(cam.protectId, startMs, endMs, stem, ac.signal, base);
      // Without an early stage (one channel, or the base and high file ready together), both are the full window.
      full.then(base, () => {});
      f = { early: Promise.race([first, full]), full, ac, waiters: 0 };
      f.early.catch(() => {}); // awaited only by early requests, which may be none
      this.inflight.set(key, f);
      full.catch(() => {}).finally(() => this.inflight.delete(key));
    }
    // The export is cancelled once every request waiting on it has been cancelled. A request that got
    // its answer stops counting, so a finished early request doesn't keep the high file going.
    const entry = f;
    entry.waiters++;
    let counted = true;
    const release = (cancel: boolean) => { if (!counted) return; counted = false; if (--entry.waiters <= 0 && cancel) entry.ac.abort(); };
    const onAbort = () => release(true);
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await (early ? entry.early : entry.full);
    } catch (e) {
      if (signal?.aborted) throw new HttpError(499, "cancelled");
      // Fetching a degraded window again failed: what it had is better than nothing.
      if (cached) return cached.w;
      if (isNoRecording(e)) throw new HttpError(404, "no_recording", "Nothing recorded at this time");
      log("warn", "playback window failed", { error: e });
      throw new HttpError(503, "nvr_unavailable");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      release(false);
    }
  }

  /**
   * A complete cached window, or null; `stale` when it was degraded and is due to be fetched again.
   * Housekeeping evicts files one by one, so every part is checked.
   */
  private async cached(stem: string): Promise<{ w: PlaybackWindow; stale: boolean } | null> {
    try {
      const { refetchAfter, ...info } = JSON.parse(await readFile(`${stem}.json`, "utf8")) as SavedWindow, high = info.high ? `${stem}.hi.mp4` : null;
      await Promise.all([stat(`${stem}.mp4`), high && stat(high)]);
      const stale = refetchAfter != null && Date.now() >= refetchAfter;
      // A stale window is not kept alive by being read: housekeeping may take it.
      const t = new Date();
      if (!stale) for (const p of [`${stem}.json`, `${stem}.mp4`, high]) if (p) void utimes(p, t, t).catch(() => {});
      return { w: { info, base: `${stem}.mp4`, high }, stale };
    } catch { return null; }
  }

  /** The recorder's segment lists around [startMs, endMs), for `fetchRecorded`. */
  private segments(protectId: string, startMs: number, endMs: number): ListSegments {
    return (channel, signal) => this.adapter().recordedSegments(protectId, startMs, endMs, channel, signal);
  }

  /** The recorder's time for each GOP of [startMs, endMs), for `fetchRecorded`; undefined when the adapter has none. */
  private stamps(protectId: string, startMs: number, endMs: number): ListStamps | undefined {
    const ad = this.adapter();
    return ad.recordedStamps ? (channel, signal, reach) => ad.recordedStamps!(protectId, startMs - (reach?.beforeMs ?? 0), endMs + (reach?.afterMs ?? 0), channel, signal) : undefined;
  }

  /**
   * The recorder's export of one channel of [startMs, endMs), for `fetchRecorded`. With `retry`, an
   * export that fails for any reason other than "nothing recorded" (the recorder answering with an
   * error or timing out, a dropped connection) is tried again after each of `retryDelaysMs`. A long
   * clip asks the recorder for several exports at once, and a piece lost to a passing hiccup would
   * otherwise be missing from the clip.
   */
  private exporter(protectId: string, startMs: number, endMs: number, retry: boolean): ExportChannel {
    return async (quality, dest, signal, reach) => {
      const ad = this.adapter();
      for (let i = 0; ; i++) {
        try {
          return await ad.exportClip(protectId, startMs - (reach?.beforeMs ?? 0), endMs + (reach?.afterMs ?? 0), dest, { quality, signal });
        } catch (e) {
          if (!retry || signal.aborted || isNoRecording(e) || i >= this.retryDelaysMs.length) throw e;
          log("info", "the recorder could not export part of a clip; trying again", { protectId, startMs, quality, attempt: i + 1, error: e });
          await sleep(this.retryDelaysMs[i], undefined, { signal });
        }
      }
    };
  }

  /**
   * Exports a playback window (`fetchRecorded`): a base file and, for adaptive recordings, a high
   * file and the order to play them in. `onBase` gets the base alone as soon as it is ready.
   */
  private async build(protectId: string, startMs: number, endMs: number, stem: string, signal: AbortSignal, onBase: (w: PlaybackWindow) => void): Promise<PlaybackWindow> {
    await mkdir(this.dir("playback"), { recursive: true, mode: 0o700 });
    const tmp = `${stem}.${newId()}`, files = { focus: `${tmp}.f.part`, wall: `${tmp}.w.part`, context: `${tmp}.c.part` }, base = `${stem}.mp4`;
    const window = (r: Recorded, extra: Partial<WindowInfo> = {}): WindowInfo => ({ startMs, endMs, entries: r.entries, high: !!r.high, seams: r.seams, ...extra });
    let moved: Promise<void> | null = null;
    try {
      const r = await fetchRecorded(this.exporter(protectId, startMs, endMs, false), startMs, endMs, {
        files, signal, segments: this.segments(protectId, startMs, endMs), stamps: this.stamps(protectId, startMs, endMs), context: { protectId }, known: { ...this.known },
        // The base file is final once handed over: it takes its place now, so the player can start on it.
        onBase: (e) => { moved = rename(e.base, base).then(() => onBase({ info: window(e, { pending: true }), base, high: null })); moved.catch(() => {}); },
      });
      for (const k of ["segments", "stamps"] as const) if (r.got[k]) this.known[k] = true;
      if (moved) await moved; else await rename(r.base, base);
      const info = window(r);
      if (r.high) await rename(r.high, `${stem}.hi.mp4`);
      const saved: SavedWindow = r.degraded ? { ...info, refetchAfter: Date.now() + DEGRADED_KEEP_MS } : info;
      await writeFile(`${tmp}.json.part`, JSON.stringify(saved), { mode: 0o600 });
      await rename(`${tmp}.json.part`, `${stem}.json`);
      return { info, base, high: r.high && `${stem}.hi.mp4` };
    } finally {
      await Promise.all([files.focus, files.wall, files.context, `${tmp}.json.part`].map((p) => rm(p, { force: true })));
    }
  }

  /** One piece of a clip, as a single file covering the whole piece (`fetchRecordedFile`). */
  private async exportPiece(protectId: string, startMs: number, endMs: number, path: string, signal: AbortSignal, join: PieceOptions) {
    const files = { focus: `${path}.f`, wall: `${path}.w`, context: `${path}.c` };
    try {
      return await fetchRecordedFile(this.exporter(protectId, startMs, endMs, true), startMs, endMs, path, { files, signal, ...join, segments: this.segments(protectId, startMs, endMs), stamps: this.stamps(protectId, startMs, endMs), context: { protectId }, known: { ...this.known } });
    } finally {
      await Promise.all([files.focus, files.wall, files.context].map((p) => rm(p, { force: true })));
    }
  }

  // ---- clip export jobs -------------------------------------------------
  /** The grant a job was created under, as stored in its row. */
  private grantOf(j: typeof schema.exportJobs.$inferSelect): CameraGrant {
    return { sessionId: j.sessionId, subjectId: j.subjectId, previewId: j.previewId ?? undefined, cameraId: j.cameraId, needs: "clipExport" };
  }
  createExport(a: Actor, cameraId: string, startMs: number, endMs: number) {
    // The camera first, so a hidden camera answers exactly like a missing one whatever this person may do.
    const cam = this.policy.camera(subjectOf(a), cameraId), max = config().CLIP_MAX_SECONDS * 1000;
    if (!this.policy.canExportClips(subjectOf(a))) throw new HttpError(403, "clips_not_allowed", "You can't save clips. Ask an administrator if you need to.");
    if (!(endMs > startMs) || endMs - startMs > max || endMs > Date.now()) throw badRequest(`Clips can be up to ${fmtLimit(config().CLIP_MAX_SECONDS)} long.`);
    // A long clip ties up the recorder for minutes, so each session prepares at most two at a time.
    const running = this.db.select({ id: schema.exportJobs.id }).from(schema.exportJobs).where(and(eq(schema.exportJobs.sessionId, a.sessionId), eq(schema.exportJobs.status, "running"))).all();
    if (running.filter((j) => this.jobs.has(j.id)).length >= 2) throw new HttpError(429, "too_many_exports", "Two clips are already being prepared. Wait for one to finish.");
    const id = newId(), t = Date.now(), file = join(this.dir("exports"), `${id}.mp4`), g = this.access.grant(a, cameraId);
    this.db.insert(schema.exportJobs).values({ id, sessionId: g.sessionId, subjectId: g.subjectId, previewId: g.previewId ?? null, cameraId: g.cameraId, startMs, endMs, status: "running", progress: 0, filePath: file, createdAt: t, expiresAt: t + EXPORT_KEEP + prepTime(endMs - startMs) }).run();
    audit(this.db, { actorId: a.userId, previewSubjectId: a.preview?.subjectId, action: "clip.export", targetType: "camera", targetId: cameraId, requestId: a.requestId, ip: a.ip, detail: { startMs, endMs } });
    const ac = new AbortController();
    this.jobs.set(id, ac);
    const set = (v: Partial<typeof schema.exportJobs.$inferInsert>) => this.db.update(schema.exportJobs).set(v).where(and(eq(schema.exportJobs.id, id), eq(schema.exportJobs.status, "running"))).run();
    void (async () => {
      try {
        await mkdir(this.dir("exports"), { recursive: true, mode: 0o700 });
        const began = Date.now();
        const { busy, coveredMs, stats } = await this.exportPieces(cam.protectId, startMs, endMs, file, ac.signal, (f, ms) => { set({ progress: Math.round(f * 95) }); this.etas.set(id, { ms, at: Date.now() }); });
        // What the pieces cover tells whether time is missing, whatever the cause: a piece left out,
        // or time the recorder doesn't have. The file can be longer than asked (high-resolution
        // moments the low channel lacks play on their own) or start a little early, never late.
        const durationMs = Math.round((await probe(file, ac.signal)).duration * 1000), missing = endMs - startMs - coveredMs;
        const gap = missing >= Math.max(MISSING_MIN, (endMs - startMs) / 100) ? (busy ? "busy" : "unrecorded") : null;
        if (gap) log("info", "a saved clip is missing time", { cameraId, startMs, endMs, durationMs, coveredMs, gap });
        log("info", "clip saved", { cameraId, startMs, endMs, durationMs, coveredMs, tookMs: Date.now() - began, ...stats });
        set({ status: "ready", progress: 100, durationMs, gap, expiresAt: Date.now() + EXPORT_KEEP });
      } catch (e) {
        await rm(file, { force: true });
        if (!ac.signal.aborted && !isNoRecording(e)) log("warn", "clip export failed", { cameraId, startMs, endMs, error: e });
        set({ status: ac.signal.aborted ? "cancelled" : "failed", error: isNoRecording(e) ? "Nothing was recorded during that time." : isRecorderBusy(e) ? "The recorder is busy. Try again in a few minutes." : "Something went wrong. Try again." });
      } finally { this.jobs.delete(id); this.etas.delete(id); }
    })();
    return { id };
  }
  /**
   * Exports a clip in pieces of up to `PIECE`, `CLIP_EXPORT_PARALLEL` at a time, then joins them
   * without re-encoding. The recorder builds a whole export before sending the first byte, so pieces
   * are what make progress measurable, and running a few at once shortens the wait. Each piece starts
   * with the last keyframe before its start (its lead), which the piece before ends with. Where a
   * piece carries on after the one before is `startAfter`, from what that piece really was: a plain
   * piece is cut when joined, and a rendered one is rendered from there once the piece before is
   * fetched (each piece's `fetched`). A piece with nothing recorded is left out. So is one the recorder still fails after its retries
   * (`exporter`), and `busy` then says the clip may be missing time that was recorded; if no piece
   * could be exported at all, the clip fails.
   *
   * With `CLIP_MATCH_RESOLUTION`, pieces with a smaller picture (adaptive recording's low stretches)
   * are re-encoded at the largest size while the rest download (`SizeMatcher`), so the clip plays at
   * one size. `onProgress` gets the fraction of the work done and a rough time left: the average piece
   * so far, times the pieces left, shared among the workers, or the resizes still queued if longer.
   */
  private async exportPieces(protectId: string, startMs: number, endMs: number, file: string, signal: AbortSignal, onProgress: (f: number, etaMs: number) => void): Promise<{ busy: boolean; coveredMs: number; stats: { pieces: number; combined: number; combineMs: number; resized: number; resizeMs: number; joinMs: number } }> {
    const n = Math.max(1, Math.ceil((endMs - startMs) / PIECE));
    const parts = Array.from({ length: n }, (_, i) => {
      let fetched!: (s: Seams | null) => void;
      // Settles once the piece is fetched, or with null when it is left out or the clip fails.
      const seams = new Promise<Seams | null>((r) => { fetched = r; });
      return { i, a: startMs + i * PIECE, b: Math.min(endMs, startMs + (i + 1) * PIECE), path: n === 1 ? `${file}.part` : `${file}.${i}.part`, piece: null as Piece | null, seams, fetched };
    });
    const local = new AbortController(), stop = () => local.abort();
    signal.addEventListener("abort", stop, { once: true });
    const width = Math.min(n, config().CLIP_EXPORT_PARALLEL);
    let next = 0, done = 0, spent = 0, shown = 0, busy = false, combined = 0, combineMs = 0;
    const report = () => {
      if (!done) return;
      const s = sizes ?? { pending: 0, done: 0, spentMs: 0 }, perFit = s.done ? s.spentMs / s.done : 10_000;
      shown = Math.max(shown, (done + s.done) / (n + s.done + s.pending));
      onProgress(shown, Math.max(Math.round(((spent / done) * (n - done)) / width), Math.round(s.pending * perFit)));
    };
    const sizes = config().CLIP_MATCH_RESOLUTION ? new SizeMatcher(local.signal, report) : null;
    const worker = async () => {
      while (next < n && !local.signal.aborted) {
        const p = parts[next++], t = Date.now();
        try {
          // The piece before was taken up earlier, so waiting for it to be fetched never waits on this one.
          const r = await this.exportPiece(protectId, p.a, p.b, p.path, local.signal, { before: p.i > 0 ? parts[p.i - 1].seams : undefined, onFetched: p.fetched });
          p.piece = r; busy ||= r.busy;
          if (r.combineMs) { combined++; combineMs += r.combineMs; }
          sizes?.add(p.path);
        } catch (e) {
          if (isRecorderBusy(e) && !local.signal.aborted) { busy = true; log("warn", "part of a clip is left out: the recorder kept failing to export it", { protectId, startMs: p.a, error: e }); }
          else if (!isNoRecording(e)) { local.abort(); throw e; }
        } finally { p.fetched(null); }
        done++; spent += Date.now() - t;
        report();
      }
    };
    try {
      const r = await Promise.allSettled(Array.from({ length: width }, worker));
      signal.throwIfAborted();
      const bad = r.find((x) => x.status === "rejected");
      if (bad) throw bad.reason;
      const got = parts.filter((p) => p.piece);
      if (!got.length) throw busy ? new RecorderBusyError(0) : new NoRecordingError();
      const fitted = sizes ? await sizes.finish() : new Map<string, string>(), joinAt = Date.now();
      if (got.length === 1) await rename(fitted.get(got[0].path) ?? got[0].path, file);
      else await joinParts(got.map((p) => {
        const pc = p.piece!, prev = p.i > 0 ? parts[p.i - 1].piece : null;
        const skip = pc.rendered ? 0 : pc.entries.slice(0, startAfter(prev?.seams ?? null, pc)).reduce((s, e) => s + e.len, 0);
        return { path: fitted.get(p.path) ?? p.path, inpoint: skip > 0.05 ? pc.info.start + skip : undefined };
      }), file, signal);
      const coveredMs = got.reduce((s, p) => s + p.piece!.coveredMs, 0);
      return { busy, coveredMs, stats: { pieces: got.length, combined, combineMs, resized: sizes?.done ?? 0, resizeMs: sizes?.spentMs ?? 0, joinMs: Date.now() - joinAt } };
    } finally {
      signal.removeEventListener("abort", stop);
      local.abort();
      await sizes?.cleanup();
      await Promise.all(parts.map((p) => rm(p.path, { force: true })));
    }
  }
  /** Rough time left for a running job, or null before it can be measured. */
  exportEta(id: string): number | null {
    const e = this.etas.get(id);
    return e ? Math.max(0, e.ms - (Date.now() - e.at)) : null;
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
    // Files left behind by a restart mid-export (pieces, join lists) belong to no job.
    const live = new Set(this.db.select({ id: schema.exportJobs.id }).from(schema.exportJobs).all().map((j) => j.id));
    for (const f of await readdir(this.dir("exports")).catch(() => [] as string[])) if (!live.has(f.split(".")[0])) await rm(join(this.dir("exports"), f), { force: true });
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
