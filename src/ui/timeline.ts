import { dayBounds } from "./api";

export const DAY = 24 * 3600_000;

/**
 * The stretch of time the unzoomed timeline covers. Normally the last 24 hours, ending now, so live
 * sits at the right edge. A calendar day (midnight to midnight) is shown instead when the playhead
 * is older than that, or when a past date was picked and the playhead is still before today.
 */
export function timelineBounds(t: number, clock: number, pinned: boolean, tz: string): { rolling: boolean; lo: number; hi: number } {
  const today = dayBounds(clock, tz)[0];
  if (t < clock - DAY || (pinned && t < today)) { const [lo, hi] = dayBounds(t, tz); return { rolling: false, lo, hi }; }
  return { rolling: true, lo: clock - DAY, hi: clock };
}

/** Timeline labels from `a` to `b`, `step` apart and lined up on midnight in the chosen time zone. */
export function tickTimes(a: number, b: number, step: number, tz: string): number[] {
  const base = dayBounds(a, tz)[0], out: number[] = [];
  for (let m = base + Math.ceil((a - base) / step) * step; m <= b; m += step) out.push(m);
  return out;
}

/** "5 hr 12 min ago", for a moment within the last two days; null otherwise. */
export function fmtAgo(ms: number): string | null {
  if (ms < 0 || ms >= 2 * DAY) return null;
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60);
  if (!m) return `${Math.max(1, Math.floor(ms / 1000))} sec ago`;
  return h ? `${h} hr${m % 60 ? ` ${m % 60} min` : ""} ago` : `${m} min ago`;
}

/** "8 seconds not recorded", "3 minutes not recorded": the length of a stretch playback skipped over. */
export function fmtSkipped(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000)), m = Math.round(s / 60);
  return s < 60 ? `${s} second${s === 1 ? "" : "s"} not recorded` : `${m} minute${m === 1 ? "" : "s"} not recorded`;
}

/** Recorded ranges with the holes cut out of them: what the timeline's bar draws. Both are [from, to] ms. */
export function cutHoles(ranges: [number, number][], holes: [number, number][]): [number, number][] {
  const hs = [...holes].sort((x, y) => x[0] - y[0]), out: [number, number][] = [];
  for (const [s, e] of ranges) {
    let at = s;
    for (const [hs0, he] of hs) {
      if (he <= at || hs0 >= e) continue;
      if (hs0 > at) out.push([at, hs0]);
      at = he;
    }
    if (at < e) out.push([at, e]);
  }
  return out;
}

/** How far from an event dot, in pixels, the pointer still picks it: wider for a finger. */
export const DOT_REACH_PX = { mouse: 8, touch: 16 };

/** The event whose dot is nearest `ms` and no further than `reach` from it, if any. */
export function nearestEvent<E extends { startMs: number }>(events: E[], ms: number, reach: number): E | undefined {
  let best: E | undefined;
  for (const e of events) if (Math.abs(e.startMs - ms) <= reach && (!best || Math.abs(e.startMs - ms) < Math.abs(best.startMs - ms))) best = e;
  return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** "6 hours", "1.5 hours", "10 minutes": how much time a zoomed timeline shows. */
export const fmtSpan = (ms: number) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${+(m / 60).toFixed(1)} hour${m === 60 ? "" : "s"}` : `${m} minute${m === 1 ? "" : "s"}`; };

/**
 * How much one wheel or pinch event zooms a timeline: a factor above 1 widens it (wheel down, pinch in),
 * below 1 narrows it. Proportional to the scroll, so a trackpad zooms smoothly and a mouse wheel a little
 * per notch. Null for a sideways scroll.
 */
export function wheelZoom(e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey">): number | null {
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return null;
  return Math.exp(clamp(e.deltaY * px, -100, 100) * (e.ctrlKey ? 0.01 : 0.004));
}

/** The closest the player's and the wall's timelines zoom: one minute across. */
export const MIN_SPAN = 60_000;
/** Where the zoom buttons and keys stop on the way in or out, besides the whole timeline and `MIN_SPAN`. */
const ZOOM_STOPS = [6 * 3600_000, 3600_000, 600_000];
/**
 * A timeline's zoom: how much time it shows (Infinity for all of it) and where that stretch starts
 * (null to place it around the playhead).
 */
export type Zoom = { span: number; start: number | null };
export const UNZOOMED: Zoom = { span: Infinity, start: null };

/**
 * The stretch of `[lo, hi]` a timeline at `z` shows. Zoomed in, it holds still while the playhead `t`
 * is inside it, so clicks and drags land where aimed, and re-centres when the playhead leaves (live
 * sits near the right edge).
 */
export function zoomedView(z: Zoom, t: number, lo: number, hi: number, live: boolean): [number, number] {
  const span = Math.min(z.span, hi - lo), s = z.start;
  if (span >= hi - lo) return [lo, hi];
  const fits = s !== null && s >= lo && s + span <= hi && t >= s && t <= s + span;
  const a = fits ? s : clamp(t - span * (live ? 0.9 : 0.5), lo, hi - span);
  return [a, a + span];
}

/**
 * Zooms by `factor` (above 1 widens), keeping the moment at `frac` of the width in place, or the
 * playhead when `frac` is undefined (the buttons and keys). The playhead never leaves the view, so the
 * zoom drifts towards it when the pointer is far from it.
 */
export function zoomTimeline(z: Zoom, factor: number, frac: number | undefined, t: number, lo: number, hi: number, live: boolean): Zoom {
  const [a, b] = zoomedView(z, t, lo, hi, live), full = hi - lo;
  const span = clamp((b - a) * factor, Math.min(MIN_SPAN, full), full);
  if (span >= full) return UNZOOMED;
  const f = frac ?? clamp((t - a) / (b - a), 0, 1), at = a + f * (b - a);
  const s = clamp(clamp(at - f * span, t - span, t), lo, hi - span);
  return { span, start: s };
}

/** The span the zoom buttons and keys go to next from `span`: the next stop in (`dir` 1) or out (-1). */
export function nextZoomStop(span: number, dir: 1 | -1, full: number): number {
  const stops = [full, ...ZOOM_STOPS.filter((s) => s < full), MIN_SPAN];
  return dir > 0 ? (stops.find((s) => s < span * 0.99) ?? MIN_SPAN) : (stops.findLast((s) => s > span * 1.01) ?? full);
}
