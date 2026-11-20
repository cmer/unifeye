import { rename } from "node:fs/promises";
import { isCodec, timedEncode } from "../protect/encoders";
import { gopsOf, probe, renderEntries, retimeVideoToAudio, thumbnails, videoSizes, type MediaInfo } from "../protect/ffmpeg";
import { isNoRecording, isRecorderBusy } from "../protect/types";
import { log } from "../util";
import { highReachMs, PLACEMENT, placeStretch, stampsFit, type Context, type Thumbs } from "./placement";
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
 * - Without segment lists (the recorder doesn't offer them, or failed to answer), stamps decide when
 *   there are any (both channels, as below). Otherwise the files do: channel 0 alone unless it comes
 *   back short and the low channel holds more at a smaller size.
 * - When the recorder can name each GOP's time (`stamps`), an adaptive stretch is placed by those
 *   times instead of by guesses: the low channel's are the timeline, and pictures only measure how
 *   late the high channel's run. The high file is then exported past the stretch's end
 *   (`highReachMs`), because a GOP recorded inside the stretch can be stamped after it; whatever was
 *   recorded outside the stretch is left to the stretches there. To tell which GOPs those are, the
 *   pictures are compared with a longer export of the low channel (`files.context`, the same reach
 *   before and after), which is only looked at. If the stamps do not fit the files, or there is no
 *   context, the stretch is fetched and placed the old way.
 * - Anything missing that the recorder normally gives (a segment list, stamps, an export it failed)
 *   is named in `degraded`, so a cache can fetch the stretch again once the hiccup has passed.
 */

/** How much more than the stretch itself to ask for, before its start and after its end. */
export interface Reach { beforeMs?: number; afterMs?: number }
/**
 * Writes the recorder's export of one channel to `dest`. The caller decides retries; errors are the
 * adapter's.
 */
export type ExportChannel = (channel: "focus" | "wall", dest: string, signal: AbortSignal, reach?: Reach) => Promise<void>;
/**
 * The recorder's time for each GOP the export of one channel holds (with the same `reach`), or null
 * when it cannot say.
 */
export type ListStamps = (channel: "focus" | "wall", signal: AbortSignal, reach?: Reach) => Promise<number[] | null>;
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
  /** Where the base file's first GOP ends, in its media time. */
  leadEnd?: number;
  /**
   * Whether the recorder gave what was asked of it: its segment lists, and stamps that fit the files.
   * A key is absent when it was not asked. Callers learn from it what this recorder offers (`known`).
   */
  got: { segments?: boolean; stamps?: boolean };
  /**
   * Why this is less than the recorder gave before (`FetchOptions.known`): a segment list or stamps
   * missing, or an export failing ("segments", "stamps", "busy"). A passing hiccup as a rule, so the
   * answer is worth fetching again later rather than keeping. Absent when nothing went wrong.
   */
  degraded?: string[];
}

export interface FetchOptions {
  /**
   * Scratch paths for the two channels' exports, and for the longer low-channel export that stamps
   * need (`context`; without it stamps only time the low channel). The caller deletes them afterwards.
   */
  files: { focus: string; wall: string; context?: string };
  signal: AbortSignal;
  ops?: MediaOps;
  /** The recorder's segment lists, when it offers them. */
  segments?: ListSegments;
  /** The recorder's time for each GOP, when it offers them (adaptive stretches only ask). */
  stamps?: ListStamps;
  /**
   * Called once the base is ready, before the high channel is placed on it (which waits for the
   * larger high-resolution export), with entries for the base alone. Lets playback start sooner.
   */
  onBase?: (r: Recorded) => void;
  /** Added to log lines (a camera id, say). */
  context?: Record<string, unknown>;
  /**
   * What this recorder has given before (`Recorded.got`). Missing now, it is a hiccup: a stretch
   * without its segment lists is then placed by the stamps, and the answer says it is `degraded`.
   * A recorder that never gives them is not asked to make up for them.
   */
  known?: { segments?: boolean; stamps?: boolean };
  /**
   * The low channel alone, for small pictures (a wall tile): no high-resolution file, so nothing to
   * export at full size or place. Moments only the high channel holds are left out. Channel 0 is
   * exported only when the low channel has nothing.
   */
  lowOnly?: boolean;
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
  const got: Recorded["got"] = {}, r = await fetchOnce(exportChannel, startMs, endMs, opts, got);
  const why = (["segments", "stamps"] as const).filter((k) => got[k] === false && opts.known?.[k]) as string[];
  if (r.busy) why.push("busy");
  if (!why.length) return { ...r, got };
  // The onBase answer is not marked: the full answer that follows is what callers keep.
  log("warn", "a recorded stretch was placed with less than the recorder usually gives", { ...opts.context, startMs, missing: why });
  return { ...r, got, degraded: why };
}

async function fetchOnce(exportChannel: ExportChannel, startMs: number, endMs: number, opts: FetchOptions, got: Recorded["got"]): Promise<Omit<Recorded, "got">> {
  const { files, signal, ops = ffmpegOps, context, onBase } = opts;
  const span = (endMs - startMs) / 1000, window = { startMs, endMs };
  const lists = opts.segments ? await Promise.all((["focus", "wall"] as const).map((c) => opts.segments!(c, signal).catch((e) => { if (signal.aborted) throw e; return null; }))) : [null, null];
  const segs = { focus: lists[0], wall: lists[1] };
  if (opts.segments) got.segments = !!(segs.focus && segs.wall);
  const get = (channel: "focus" | "wall", reach?: Reach) => exportChannel(channel, files[channel], signal, reach).then(() => files[channel]);
  const stampsOf = (channel: "focus" | "wall", reach?: Reach): Promise<number[] | null> => (opts.stamps ? opts.stamps(channel, signal, reach).catch((e) => { if (signal.aborted) throw e; return null; }) : Promise.resolve(null));
  const reach = opts.stamps && files.context ? highReachMs() : 0;
  /** A file played on its own (or as the base): clock repaired, GOPs read, entries for it alone. */
  const asBase = async (channel: "focus" | "wall") => {
    const path = files[channel];
    await ops.retime(path, signal).catch((e) => { if (signal.aborted) throw e; log("warn", "could not retime export", { ...context, channel, error: e }); });
    const g = await ops.gops(path, signal);
    if (!g.gops.length) throw new Error("the export has no video");
    return { path, channel, ...g };
  };
  const alone = (b: Awaited<ReturnType<typeof asBase>>, busy = false, frames?: Thumbs, stamps?: number[] | null): Omit<Recorded, "got"> => {
    const { entries } = placeStretch(window, { gops: b.gops, end: b.end, segments: segs[b.channel], frames, stamps: stamps ?? undefined });
    return { base: b.path, high: null, entries, seams: { base: seamOf(b.gops), high: null }, busy, leadEnd: b.gops[1]?.t ?? b.end };
  };
  /** Channel 0 first; the low channel when channel 0 has nothing or keeps failing. */
  const single = async (first: "focus" | "wall") => {
    try {
      // The low channel of an adaptive camera has holes: its stamps say where. Channel 0 alone is not asked (its stamps run late).
      const stamps = first === "wall" ? stampsOf("wall") : null;
      stamps?.catch(() => {});
      await get(first);
      const b = await asBase(first), st = await stamps;
      if (stamps) got.stamps = stampsFit(b.gops, st ?? undefined);
      return alone(b, false, undefined, st);
    } catch (e) {
      if (first === "wall" || signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e;
      // Low channel failing too: "nothing recorded" keeps the first answer; anything else is the real problem.
      await get("wall").catch((w) => { throw isNoRecording(w) ? e : w; });
      return alone(await asBase("wall"));
    }
  };

  // A segment list missing from a recorder that gives them is a passing hiccup: the stamps still tell
  // everything that matters, so both channels are fetched and placed by them, not the old way.
  const mode = channelsFor(segs.focus, segs.wall, startMs, endMs) ?? (reach && opts.known?.segments && opts.known.stamps ? "both" : null);
  if (mode === "focus" || mode === "wall") return single(mode);
  if (opts.lowOnly) {
    try { return await single("wall"); } catch (e) {
      if (signal.aborted || !isNoRecording(e)) throw e;
      return single("focus");
    }
  }
  // Both channels: the low one is the base. Without segment lists or stamps, channel 0 decides first.
  let focus: Promise<string | null>, wall: Promise<string | null>, busy = false, focusErr: unknown = null, wallErr: unknown = null;
  let lowStamps: Promise<number[] | null> = Promise.resolve(null), highStamps: Promise<number[] | null> = Promise.resolve(null), reached = 0;
  let around: Promise<Context | null> = Promise.resolve(null);
  if (mode === "both") {
    reached = reach;
    lowStamps = stampsOf("wall");
    lowStamps.catch(() => {});
    if (reach) {
      const wide = { beforeMs: reach, afterMs: reach }, path = files.context!;
      highStamps = stampsOf("focus", { afterMs: reach });
      highStamps.catch(() => {});
      // The low channel a while either side of the stretch, to compare the high GOPs with.
      around = (async () => {
        const [stamps] = await Promise.all([stampsOf("wall", wide), exportChannel("wall", path, signal, wide)]);
        const g = await ops.gops(path, signal);
        if (!stamps || !stampsFit(g.gops, stamps)) return null;
        return { gops: g.gops, stamps, frames: await ops.thumbnails(path, { keyframes: false, ...PLACEMENT.thumb }, signal) };
      })().catch((e) => { if (signal.aborted) throw e; log("warn", "could not fetch the low channel around a stretch", { ...context, startMs, error: e }); return null; });
      around.catch(() => {});
    }
    focus = get("focus", reach ? { afterMs: reach } : undefined).catch((e) => { if (signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e; focusErr = e; return null; });
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
    // Played on its own, the high file must be the stretch's, not one reaching past it.
    if (reached) await get("focus");
    return alone(await asBase("focus"), busy);
  }
  const b = await asBase("wall");
  const frames = await ops.thumbnails(b.path, { keyframes: false, ...PLACEMENT.thumb }, signal);
  const ls = await lowStamps, baseStamps = stampsFit(b.gops, ls ?? undefined) ? ls : null;
  if (mode === "both" && opts.stamps) got.stamps = !!baseStamps;
  const early = alone(b, busy, frames, baseStamps);
  onBase?.({ ...early, got: { ...got } });
  let f = await focus;
  if (!f) return { ...early, busy: busy || isRecorderBusy(focusErr) };
  let h = await ops.gops(f, signal), hs = await highStamps;
  // Channel 0 hands back the low picture where it has no high one: nothing to place, and no high
  // stamps to expect (the stream then sends none). A file that reaches past the stretch starts with
  // the base's GOPs and carries on with later ones, which belong to the stretches there.
  const lowHashes = new Set(b.gops.map((g) => g.hash));
  const lowOnly = (gs: Gop[]) => gs.length < 2 || gs.slice(0, b.gops.length).every((g) => lowHashes.has(g.hash));
  if (lowOnly(h.gops)) return early;
  const ctx = await around;
  if (reached && !(baseStamps && ctx && stampsFit(h.gops, hs ?? undefined, PLACEMENT.lag.stepBackSec * 1000))) {
    // No usable stamps after all: the old placement needs the high file of the stretch itself.
    log("warn", "the recorder's times do not fit its export; placing by pictures alone", { ...context, startMs, lowGops: b.gops.length, lowStamps: ls?.length ?? null, highGops: h.gops.length, highStamps: hs?.length ?? null, context: !!ctx });
    got.stamps = false;
    hs = null;
    f = await get("focus").catch((e) => { if (signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e; focusErr = e; return null; });
    if (!f) return { ...early, busy: busy || isRecorderBusy(focusErr) };
    h = await ops.gops(f, signal);
    if (lowOnly(h.gops)) return early;
  }
  const keys = await ops.thumbnails(f, { keyframes: true, ...PLACEMENT.thumb }, signal);
  const { entries, trace } = placeStretch(window, { gops: b.gops, end: b.end, segments: segs.wall, frames, stamps: hs ? baseStamps! : undefined, context: hs && ctx ? ctx : undefined }, { gops: h.gops, end: h.end, segments: segs.focus, keys, stamps: hs ?? undefined });
  const matched = trace.high!.matched.filter((a, g) => a != null && (hs || g > 0)).length;
  log("info", "adaptive recording placed", { ...context, startMs, lowGops: b.gops.length, highGops: h.gops.length, matched, unpaired: trace.unpaired, ...(trace.high!.lag ? { stamped: true, lagSec: [Math.round(Math.min(...trace.high!.lag)), Math.round(Math.max(...trace.high!.lag))] } : {}) });
  // A high file that reaches past the stretch ends with GOPs of later stretches: its seam is the last
  // GOP before the first one stamped past this stretch, which is the GOP the next stretch's export
  // starts with. (High stamps are not always in order, so this counts from the start of the file.)
  const past = hs ? hs.findIndex((t) => t >= endMs) : -1, inside = past < 0 ? h.gops : h.gops.slice(0, past);
  return { base: b.path, high: f, entries, seams: { base: seamOf(b.gops), high: seamOf(inside.length ? inside : h.gops) }, busy };
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
  // A plain piece is joined by cutting whole GOPs, so its whole first GOP is the lead here (with
  // stamps, only the part before the stretch is flagged).
  const info = await ops.probe(path, signal), base = r.entries.filter((e) => e.kind !== "insert").flatMap((e): Entry[] => {
    const cut = r.leadEnd == null || e.lead ? 0 : Math.min(e.len, r.leadEnd - e.base);
    if (cut <= 0.02) return [e];
    const span = (cut / e.len) * e.span, head: Entry = { ...e, len: cut, span, lead: true };
    return e.len - cut <= 0.02 ? [head] : [head, { ...e, base: e.base + cut, len: e.len - cut, at: e.at + span, span: e.span - span }];
  });
  log("info", "clip piece ready", { ...context, startMs, fetchMs, combined: false, width: info.width });
  return { info, entries: base, rendered: false, seams: { base: r.seams.base, high: null }, busy: r.busy, coveredMs: coveredMs(base, startMs, endMs), combineMs: 0 };
}
