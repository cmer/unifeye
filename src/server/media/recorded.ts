import { rename } from "node:fs/promises";
import { isCodec, timedEncode } from "../protect/encoders";
import { audioEnvelope, overlayStretches, probe, retimeVideoToAudio, videoSizes, type MediaInfo } from "../protect/ffmpeg";
import { isNoRecording, isRecorderBusy } from "../protect/types";
import { log } from "../util";
import { alignSpans, type Span } from "./align";

export type { Span } from "./align";

/**
 * Recorded video for a stretch of time [startMs, endMs), as the recorder holds it.
 *
 * Normally that is one channel 0 ("focus") export. With adaptive recording, the recorder keeps the
 * low channel all the time and the high channel only around motion, and its exports have two quirks
 * that this module owns, so nothing else needs to know about them:
 *
 * - A channel 0 export of a stretch with motion holds only the high-resolution parts, joined, with
 *   nothing saying where they belong. When it is more than a second short, the low channel ("wall")
 *   is exported too and becomes the base, and the high-resolution file becomes an overlay placed by
 *   matching both files' audio (`alignSpans`). If channel 0 has nothing at all, the low channel is
 *   used, so a stretch recorded only in low resolution is not lost.
 * - Some cameras' low channel comes out with a video clock that runs fast. Every export is retimed
 *   onto its audio clock before anything reads it (`retimeVideoToAudio`); consistent files are left alone.
 *
 * The recorder also starts an export on the keyframe before the requested time, so the base can
 * begin a few seconds early; `leadMs` says by how much.
 */

/** Writes the recorder's export of one channel to `dest`. The caller decides retries; errors are the adapter's. */
export type ExportChannel = (channel: "focus" | "wall", dest: string, signal: AbortSignal) => Promise<void>;

export interface FetchOptions {
  /** Scratch paths for the two channels' exports. The caller deletes both afterwards. */
  files: { focus: string; wall: string };
  signal: AbortSignal;
  ops?: MediaOps;
  /** Added to log lines (a camera id, say). */
  context?: Record<string, unknown>;
}

/** The media operations this module needs. FFmpeg in production (`ffmpegOps`); tests pass a fake. */
export interface MediaOps {
  probe(path: string, signal: AbortSignal): Promise<MediaInfo>;
  /** Repairs a fast video clock in place; true when the file was rewritten. */
  retime(path: string, signal: AbortSignal): Promise<boolean>;
  /** Loudness every 10 ms, for `alignSpans`. */
  envelope(path: string, signal: AbortSignal): Promise<Float64Array>;
  /** One file: `base` with `high` laid over it inside `spans`. Returns how long the encode took. */
  combine(base: string, high: string, spans: Span[], dest: string, signal: AbortSignal): Promise<{ encoder: string; ms: number }>;
}

export const ffmpegOps: MediaOps = {
  probe,
  retime: retimeVideoToAudio,
  envelope: audioEnvelope,
  async combine(base, high, spans, dest, signal) {
    const { codec } = await videoSizes(high, signal);
    if (!isCodec(codec)) throw new Error(`cannot encode ${codec}`);
    return timedEncode(codec, (enc) => overlayStretches(base, high, spans, dest, enc, signal), signal);
  },
};

/** How far before the requested start a file begins, from its length. Capped at 10 s. */
export const leadOf = (durationSec: number, startMs: number, endMs: number) => Math.min(10_000, Math.max(0, Math.round(durationSec * 1000 - (endMs - startMs))));

export interface Recorded {
  /** The file that covers the whole stretch: `files.focus` or `files.wall`. */
  base: string;
  info: MediaInfo | null;
  /** `files.focus` when it is an overlay over a low-resolution base, else null. */
  high: string | null;
  /** Where `high` sits in `base`, in seconds of media time. Empty when `high` is null. */
  overlay: Span[];
  leadMs: number;
  /** The low channel was needed but kept failing for reasons other than "nothing recorded", so time may be missing. */
  busy: boolean;
}

/**
 * Exports [startMs, endMs) into `files` (see the module comment). The caller deletes both files
 * afterwards, whichever ones `base` and `high` name. Throws NoRecordingError when neither channel has
 * anything; any other export error is thrown as is.
 */
export async function fetchRecorded(exportChannel: ExportChannel, startMs: number, endMs: number, { files, signal, ops = ffmpegOps, context }: FetchOptions): Promise<Recorded> {
  const span = (endMs - startMs) / 1000;
  const get = async (channel: "focus" | "wall") => {
    const dest = files[channel];
    await exportChannel(channel, dest, signal);
    await ops.retime(dest, signal).catch((e) => { if (signal.aborted) throw e; log("warn", "could not retime export", { ...context, channel, error: e }); });
    return dest;
  };
  const done = (base: string, info: MediaInfo | null, extra: Partial<Recorded> = {}): Recorded => ({ base, info, high: null, overlay: [], busy: false, leadMs: info ? leadOf(info.duration, startMs, endMs) : 0, ...extra });
  try {
    await get("focus");
  } catch (e) {
    if (signal.aborted || !(isNoRecording(e) || isRecorderBusy(e))) throw e;
    // Low channel failing too: "nothing recorded" keeps the first answer; anything else is the real problem.
    await get("wall").catch((w) => { throw isNoRecording(w) ? e : w; });
    return done(files.wall, await ops.probe(files.wall, signal).catch(() => null));
  }
  const f = await ops.probe(files.focus, signal).catch(() => null);
  let busy = false;
  if (f && f.duration < span - 1) {
    const w = await get("wall").then(() => ops.probe(files.wall, signal)).catch((e) => { if (signal.aborted) throw e; busy = !isNoRecording(e); return null; });
    if (w && w.duration > f.duration + 2 && w.width < f.width) {
      const overlay = f.audio && w.audio ? alignSpans(await ops.envelope(files.focus, signal), await ops.envelope(files.wall, signal)) : [];
      if (!overlay.length) log("info", "adaptive recording shown in low resolution: the high-resolution part could not be placed", { ...context, startMs });
      return done(files.wall, w, overlay.length ? { high: files.focus, overlay } : {});
    }
  }
  return done(files.focus, f, { busy });
}

/**
 * Exports [startMs, endMs) to `path` as one file covering the whole stretch, for a saved clip. When
 * adaptive recording split it into a low-resolution base and high-resolution stretches, they are
 * combined at the high resolution (`MediaOps.combine`). If that fails, the stretch is saved in low
 * resolution, so no time is missing.
 */
export async function fetchRecordedFile(exportChannel: ExportChannel, startMs: number, endMs: number, path: string, opts: FetchOptions): Promise<{ info: MediaInfo; leadMs: number; busy: boolean; combineMs: number }> {
  const { signal, ops = ffmpegOps, context } = opts;
  const t = Date.now(), r = await fetchRecorded(exportChannel, startMs, endMs, opts), fetchMs = Date.now() - t;
  if (r.high) {
    try {
      const { encoder, ms } = await ops.combine(r.base, r.high, r.overlay, path, signal);
      const info = await ops.probe(path, signal);
      log("info", "clip piece ready", { ...context, startMs, fetchMs, combined: true, combineMs: ms, encoder, width: info.width });
      return { info, leadMs: leadOf(info.duration, startMs, endMs), busy: false, combineMs: ms };
    } catch (e) {
      if (signal.aborted) throw e;
      log("warn", "a clip piece is saved in low resolution: its high-resolution parts could not be combined with it", { ...context, startMs, error: e });
    }
  }
  await rename(r.base, path);
  const info = r.info ?? (await ops.probe(path, signal));
  log("info", "clip piece ready", { ...context, startMs, fetchMs, combined: false, width: info.width });
  return { info, leadMs: leadOf(info.duration, startMs, endMs), busy: r.busy, combineMs: 0 };
}
