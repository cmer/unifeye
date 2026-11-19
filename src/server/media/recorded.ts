import { rename } from "node:fs/promises";
import { isCodec, timedEncode } from "../protect/encoders";
import { gopsOf, probe, renderEntries, retimeVideoToAudio, thumbnails, videoSizes, type MediaInfo } from "../protect/ffmpeg";
import { isNoRecording, isRecorderBusy } from "../protect/types";
import { log } from "../util";
import { PLACEMENT, placeStretch, type Thumbs } from "./placement";
import { startAfter, type Entry, type Gop, type Seam, type Seams, type Segments } from "./timeline";

export type { Entry } from "./timeline";

/**
 * Recorded video for a stretch of time [startMs, endMs), as the recorder holds it, and the order to
 * play it in.
 *
 * Most cameras record one channel and an export of channel 0 ("focus") is all there is. With adaptive
 * recording the recorder keeps two channels that take turns, with gaps in both: high resolution
 * ("focus") around motion and low resolution ("wall") otherwise, overlapping in places. An export of
 * either is a plain run of GOPs with no times inside, starting with the last keyframe before the
 * requested start. This module owns those quirks, so nothing else needs to know about them:
 *
 * - The recorder's segment lists say which channels hold this stretch (`channelsFor`). When only one
 *   does, its export is the whole story. When the low channel has time the high one lacks, both are
 *   exported: the low file is the base, and every high GOP is placed on it by comparing pictures,
 *   shown over the low moment it matches or inserted where the low file has a gap (`placement/`).
 *   Nothing recorded in either channel is left out.
 * - The base's video clock is repaired when it runs fast (`retimeVideoToAudio`). The high file is
 *   never retimed: its sound is stored apart from its picture and does not line up with it.
 * - Without segment lists (the recorder doesn't offer them), the files decide: channel 0 alone unless
 *   it comes back short and the low channel holds more at a smaller size.
 */

/** Writes the recorder's export of one channel to `dest`. The caller decides retries; errors are the adapter's. */
export type ExportChannel = (channel: "focus" | "wall", dest: string, signal: AbortSignal) => Promise<void>;
/** The recorder's segment list for one channel around the stretch, or null when it has none to give. */
export type ListSegments = (channel: "focus" | "wall", signal: AbortSignal) => Promise<Segments | null>;

/** The media operations this module needs. FFmpeg in production (`ffmpegOps`); tests pass fakes. */
export interface MediaOps {
  probe(path: string, signal: AbortSignal): Promise<MediaInfo>;
  /** Repairs a fast video clock in place; true when the file was rewritten. */
  retime(path: string, signal: AbortSignal): Promise<boolean>;
  gops(path: string, signal: AbortSignal): Promise<{ gops: Gop[]; end: number }>;
  thumbnails(path: string, o: { keyframes: boolean; w: number; h: number }, signal: AbortSignal): Promise<Thumbs>;
  /** One file playing `entries` (`renderEntries`). Returns how long the encode took. */
  render(base: string, high: string, entries: Entry[], dest: string, signal: AbortSignal): Promise<{ encoder: string; ms: number }>;
}

export const ffmpegOps: MediaOps = {
  probe,
  retime: retimeVideoToAudio,
  gops: gopsOf,
  thumbnails,
  async render(base, high, entries, dest, signal) {
    const { codec } = await videoSizes(high, signal);
    if (!isCodec(codec)) throw new Error(`cannot encode ${codec}`);
    return timedEncode(codec, (enc) => renderEntries(base, high, entries, dest, enc, signal), signal);
  },
};

export interface Recorded {
  /** The file every entry's `base` time refers to: `files.focus` or `files.wall`. */
  base: string;
  /** `files.focus` when the high channel is laid over a low-resolution base, else null. */
  high: string | null;
  /** The playback order (`placement/`). */
  entries: Entry[];
  seams: Seams;
  /** The low channel was needed but kept failing for reasons other than "nothing recorded", so time may be missing. */
  busy: boolean;
}

export interface FetchOptions {
  /** Scratch paths for the two channels' exports. The caller deletes both afterwards. */
  files: { focus: string; wall: string };
  signal: AbortSignal;
  ops?: MediaOps;
  /** The recorder's segment lists, when it offers them. */
  segments?: ListSegments;
  /**
   * Called once the base is ready, before the high channel is placed on it (which waits for the
   * larger high-resolution export), with entries for the base alone. Lets playback start sooner.
   */
  onBase?: (r: Recorded) => void;
  /** Added to log lines (a camera id, say). */
  context?: Record<string, unknown>;
}

/**
 * Which channels to export for [startMs, endMs), from the recorder's segment lists. The high
 * channel's list can be many seconds off, and both lists leave short gaps out, so only the clear
 * cases take one channel: "focus" when the low channel lists nothing in the window (or neither lists
 * anything: the export decides), "wall" when the high channel lists nothing within a minute of it.
 * Anything else is "both": every moment either channel holds is then played. Null when either list
 * is missing.
 */
export function channelsFor(high: Segments | null, low: Segments | null, startMs: number, endMs: number): "focus" | "wall" | "both" | null {
  if (!high || !low) return null;
  // A segment ends on its last keyframe, whose GOP (up to about 4 s) runs on past it.
  const lowIn = low.some(([a, b]) => a < endMs && b + 5000 > startMs);
  const highNear = high.some(([a, b]) => a < endMs + 60_000 && b + 60_000 > startMs);
  return !lowIn ? "focus" : !highNear ? "wall" : "both";
}

function merge(xs: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of xs.sort((x, y) => x[0] - y[0])) { const p = out[out.length - 1]; if (p && a <= p[1]) p[1] = Math.max(p[1], b); else out.push([a, b]); }
  return out;
}

const seamOf = (g: Gop[]): Seam => ({ first: g[0]?.hash ?? "", last: g[g.length - 1]?.hash ?? "" });

/**
 * Exports [startMs, endMs) into `files` and works out the playback order (see the module comment).
 * The caller deletes both files afterwards, whichever ones `base` and `high` name. Throws
 * NoRecordingError when neither channel has anything; any other export error is thrown as is.
 */
export async function fetchRecorded(exportChannel: ExportChannel, startMs: number, endMs: number, opts: FetchOptions): Promise<Recorded> {
  const { files, signal, ops = ffmpegOps, context, onBase } = opts;
  const span = (endMs - startMs) / 1000, window = { startMs, endMs };
  const lists = opts.segments ? await Promise.all((["focus", "wall"] as const).map((c) => opts.segments!(c, signal).catch((e) => { if (signal.aborted) throw e; return null; }))) : [null, null];
  const segs = { focus: lists[0], wall: lists[1] };
  const get = (channel: "focus" | "wall") => exportChannel(channel, files[channel], signal).then(() => files[channel]);
  /** A file played on its own (or as the base): clock repaired, GOPs read, entries for it alone. */
  const asBase = async (channel: "focus" | "wall") => {
    const path = files[channel];
    await ops.retime(path, signal).catch((e) => { if (signal.aborted) throw e; log("warn", "could not retime export", { ...context, channel, error: e }); });
    const g = await ops.gops(path, signal);
    if (!g.gops.length) throw new Error("the export has no video");
    return { path, channel, ...g };
  };
  const alone = (b: Awaited<ReturnType<typeof asBase>>, busy = false, frames?: Thumbs): Recorded => {
    const { entries } = placeStretch(window, { gops: b.gops, end: b.end, segments: segs[b.channel], frames });
    return { base: b.path, high: null, entries, seams: { base: seamOf(b.gops), high: null }, busy };
  };
  /** Channel 0 first; the low channel when channel 0 has nothing or keeps failing. */
  const single = async (first: "focus" | "wall") => {
    try {
      await get(first);
      return alone(await asBase(first));
    } catch (e) {
      if (first === "wall" || signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e;
      // Low channel failing too: "nothing recorded" keeps the first answer; anything else is the real problem.
      await get("wall").catch((w) => { throw isNoRecording(w) ? e : w; });
      return alone(await asBase("wall"));
    }
  };

  const mode = channelsFor(segs.focus, segs.wall, startMs, endMs);
  if (mode === "focus" || mode === "wall") return single(mode);
  // Both channels: the low one is the base. Without segment lists, channel 0 decides first.
  let focus: Promise<string | null>, wall: Promise<string | null>, busy = false, focusErr: unknown = null, wallErr: unknown = null;
  if (mode === "both") {
    focus = get("focus").catch((e) => { if (signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e; focusErr = e; return null; });
    wall = get("wall").catch((e) => { if (signal.aborted) throw e; wallErr = e; return null; });
    focus.catch(() => {}); // awaited below; never left unhandled if the base fails first
  } else {
    try { await get("focus"); } catch (e) {
      if (signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e;
      await get("wall").catch((w) => { throw isNoRecording(w) ? e : w; });
      return alone(await asBase("wall"));
    }
    const f = await ops.probe(files.focus, signal).catch(() => null);
    if (!f || f.duration >= span - 1) return alone(await asBase("focus"));
    const w = await get("wall").then(() => ops.probe(files.wall, signal)).catch((e) => { if (signal.aborted) throw e; busy = !isNoRecording(e); return null; });
    if (!w || !(w.duration > f.duration + 2 && w.width < f.width)) return alone(await asBase("focus"), busy);
    focus = Promise.resolve(files.focus); wall = Promise.resolve(files.wall);
  }
  if (!(await wall)) {
    // The low channel has nothing or kept failing: channel 0 alone, which then may miss time.
    busy = !isNoRecording(wallErr);
    if (!(await focus)) throw busy ? wallErr : focusErr;
    return alone(await asBase("focus"), busy);
  }
  const b = await asBase("wall");
  const frames = await ops.thumbnails(b.path, { keyframes: false, ...PLACEMENT.thumb }, signal);
  const early = alone(b, busy, frames);
  onBase?.(early);
  const f = await focus;
  if (!f) return { ...early, busy: busy || isRecorderBusy(focusErr) };
  const h = await ops.gops(f, signal);
  // Channel 0 hands back the low picture where it has no high one: nothing to place.
  const lowHashes = new Set(b.gops.map((g) => g.hash));
  if (h.gops.length < 2 || h.gops.every((g) => lowHashes.has(g.hash))) return early;
  const keys = await ops.thumbnails(f, { keyframes: true, ...PLACEMENT.thumb }, signal);
  const { entries, trace } = placeStretch(window, { gops: b.gops, end: b.end, segments: segs.wall, frames }, { gops: h.gops, end: h.end, segments: segs.focus, keys });
  const matched = trace.high!.matched.filter((a, g) => a != null && g > 0).length;
  log("info", "adaptive recording placed", { ...context, startMs, lowGops: b.gops.length, highGops: h.gops.length, matched, unpaired: trace.unpaired });
  return { base: b.path, high: f, entries, seams: { base: seamOf(b.gops), high: seamOf(h.gops) }, busy };
}

/**
 * Wall-clock time covered by `entries` inside [startMs, endMs), in ms: what a clip of that stretch
 * holds, whatever the files' lengths.
 */
export function coveredMs(entries: Entry[], startMs: number, endMs: number): number {
  return merge(entries.map((e) => [Math.max(startMs, e.at), Math.min(endMs, e.at + Math.max(e.span, e.len * 1000))] as [number, number]).filter(([a, b]) => b > a)).reduce((n, [a, b]) => n + b - a, 0);
}

export interface Piece {
  info: MediaInfo;
  /**
   * The entries the file holds, in order. A plain piece keeps its lead, which the join cuts when the
   * piece before ends with it (`startAfter`); a rendered one starts where `startAfter` says already.
   */
  entries: Entry[];
  /** The piece was rendered (adaptive recording). */
  rendered: boolean;
  /** The seams of the file as saved: without the high file's when it holds only the base. */
  seams: Seams;
  busy: boolean;
  /** Wall-clock time the file covers inside [startMs, endMs), in ms. */
  coveredMs: number;
  combineMs: number;
}

export interface PieceOptions {
  /**
   * The seams of the piece before in the clip once it is fetched, or null when there is none (it had
   * nothing recorded or could not be exported). Omitted: this is the clip's first piece.
   */
  before?: Promise<Seams | null>;
  /** Called with this piece's seams once it is fetched, for the piece after. */
  onFetched?: (seams: Seams) => void;
}

/**
 * Exports [startMs, endMs) to `path` as one file, for a saved clip. An adaptive recording is rendered
 * in playback order at the high resolution (`MediaOps.render`), from where it carries on after the
 * piece before (`startAfter`): past both leads when that piece ended with the same base GOP, else
 * from the base lead. That waits for the piece before to be fetched, not rendered, so pieces still
 * render side by side. If rendering fails, the piece is saved in low resolution, so little time is
 * missing. A plain export is kept as it is, lead included, and cut where it joins (`entries`).
 */
export async function fetchRecordedFile(exportChannel: ExportChannel, startMs: number, endMs: number, path: string, opts: FetchOptions & PieceOptions): Promise<Piece> {
  const { signal, ops = ffmpegOps, context } = opts;
  const t = Date.now(), r = await fetchRecorded(exportChannel, startMs, endMs, opts), fetchMs = Date.now() - t;
  opts.onFetched?.(r.seams);
  if (r.high) {
    // Only the base counts: the piece before may yet be saved without its high file, and it always keeps its base.
    const prev = await (opts.before ?? null);
    signal.throwIfAborted();
    try {
      const entries = r.entries.slice(startAfter(prev && { base: prev.base, high: null }, r));
      const { encoder, ms } = await ops.render(r.base, r.high, entries, path, signal);
      const info = await ops.probe(path, signal);
      log("info", "clip piece ready", { ...context, startMs, fetchMs, combined: true, combineMs: ms, encoder, width: info.width });
      return { info, entries, rendered: true, seams: r.seams, busy: r.busy, coveredMs: coveredMs(r.entries, startMs, endMs), combineMs: ms };
    } catch (e) {
      if (signal.aborted) throw e;
      log("warn", "a clip piece is saved in low resolution: its high-resolution parts could not be combined with it", { ...context, startMs, error: e });
    }
  }
  await rename(r.base, path);
  const info = await ops.probe(path, signal), base = r.entries.filter((e) => e.kind !== "insert");
  log("info", "clip piece ready", { ...context, startMs, fetchMs, combined: false, width: info.width });
  return { info, entries: base, rendered: false, seams: { base: r.seams.base, high: null }, busy: r.busy, coveredMs: coveredMs(base, startMs, endMs), combineMs: 0 };
}
