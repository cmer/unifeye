import type { WindowInfo } from "@/server/media/recordings";

/**
 * Recorded playback, without React: where a window sits in wall-clock time, when to buffer the next
 * one, when to hand over to it, and where the high-resolution overlay of an adaptive recording sits
 * on every frame. The player wires these to its video elements; tests drive them with fake elements.
 *
 * Time is cut into windows of `W` ms. A window's base file starts `leadMs` before the window (the
 * recorder began its export on an earlier keyframe), so media time 0 is wall-clock `clipStart`.
 */

/** The parts of a <video> element playback needs. */
export interface MediaPort {
  currentTime: number;
  playbackRate: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking: boolean;
  readonly error: unknown;
  play(): Promise<void>;
  pause(): void;
}

type Ranges = { ranges: [number, number][]; precision: "exact" | "bounds" };

/** How far the overlay may drift from the base before it is moved, and before it is hidden. */
const DRIFT = 0.25;
/** How close a waiting overlay must sit to its next stretch. */
const PARKED = 0.05;
const HAVE_METADATA = 1, HAVE_CURRENT_DATA = 2;

export const windowStart = (ms: number, W: number) => Math.floor(ms / W) * W;

/**
 * Wall-clock time at media time 0. With a lead, that is the lead before the window. Without one,
 * the file starts at the window start or, when gaps are known, at the first recorded moment inside it.
 */
export function clipStartOf(ws: number, W: number, leadMs: number, rec: Ranges | null): number {
  if (leadMs) return ws - leadMs;
  if (rec?.precision !== "exact") return ws;
  const r = rec.ranges.find(([a, b]) => b > ws && a < ws + W);
  return r ? Math.max(ws, r[0]) : ws;
}

/** Where to start the base file so it shows wall-clock `ms`, in seconds of media time. */
export const offsetFor = (ms: number, clipStart: number) => Math.max(0, (ms - clipStart) / 1000);

/**
 * Whether to buffer the window after `ws`: only once that one is fully recorded (it ends more than
 * two seconds ago), so a buffered window is never a partial one.
 */
export const shouldArm = (ws: number, W: number, now: number) => ws + 2 * W < now - 2000;

/**
 * Whether the buffered next window can take over in place. Otherwise the player seeks to it, which
 * loads it from scratch (or goes live when it is too recent to be recorded yet).
 */
export const canHandOver = (buffered: MediaPort | null, nextStart: number, now: number) => !!buffered && !buffered.error && nextStart < now - 5000;

/** Overlay time for base media time `t`, or null when no stretch covers it. */
export function overlayTimeAt(overlay: WindowInfo["overlay"], t: number): number | null {
  const sp = overlay.find((x) => t >= x.at && t < x.at + x.len);
  return sp ? sp.from + (t - sp.at) : null;
}

/** Where a buffered overlay should wait so it is ready when its base starts at the lead: the first stretch not yet over. */
export function overlayStartFor(info: WindowInfo): number {
  const at = info.leadMs / 1000, sp = info.overlay.find((x) => x.at + x.len > at);
  return sp ? sp.from + Math.max(0, at - sp.at) : 0;
}

/**
 * One animation frame of a playing window.
 *
 * `handOver` is true once the base has played to the window's end (`windowEnd`, wall clock). The
 * base runs on past it by the next window's lead, so this, not the file ending, is the handover point.
 *
 * With an overlay, it is kept in step with the base: moved when it drifts, matched in speed, played
 * and paused with it. Between stretches it pauses and waits at the start of the next one, so that
 * stretch can be shown the moment the base gets there. `showHigh` is true only inside a stretch once
 * the overlay has the right frame; otherwise the base shows through.
 */
export function stepFrame(base: MediaPort, high: MediaPort | null, w: { overlay: WindowInfo["overlay"]; clipStart: number; windowEnd: number }): { handOver: boolean; showHigh: boolean } {
  const handOver = !base.paused && !base.seeking && base.readyState >= HAVE_CURRENT_DATA && w.clipStart + base.currentTime * 1000 >= w.windowEnd;
  if (!high) return { handOver, showHigh: false };
  const m = base.currentTime, want = high.error ? null : overlayTimeAt(w.overlay, m);
  if (want === null) {
    if (!high.paused) high.pause();
    const up = w.overlay.find((x) => x.at > m);
    if (up && high.readyState >= HAVE_METADATA && !high.seeking && Math.abs(high.currentTime - up.from) > PARKED) high.currentTime = up.from;
    return { handOver, showHigh: false };
  }
  if (high.readyState >= HAVE_METADATA && !high.seeking && Math.abs(high.currentTime - want) > DRIFT) high.currentTime = want;
  if (high.playbackRate !== base.playbackRate) high.playbackRate = base.playbackRate;
  if (base.paused || base.seeking) { if (!high.paused) high.pause(); } else if (high.paused) void high.play().catch(() => {});
  return { handOver, showHigh: high.readyState >= HAVE_CURRENT_DATA && !high.seeking && Math.abs(high.currentTime - want) <= DRIFT };
}
