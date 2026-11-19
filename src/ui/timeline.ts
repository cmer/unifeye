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

/**
 * Turns wheel and pinch events into zoom steps for a timeline with a few fixed zoom levels: 1 to zoom
 * in (wheel up, pinch out), -1 to zoom out, 0 for nothing yet. Scrolling adds up until it is a deliberate
 * notch, then nothing more counts for a moment, so one flick of a trackpad moves one level rather than all of them.
 * Sideways scrolling is ignored.
 */
export function wheelZoomSteps(threshold = 40, pause = 300): (e: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode" | "ctrlKey" | "timeStamp">) => 1 | -1 | 0 {
  let sum = 0, last = -Infinity, until = -Infinity;
  return (e) => {
    const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) return 0;
    // A quiet spell starts the count afresh; a pause after a step is extended by the trackpad's own coasting.
    if (e.timeStamp - last > pause) sum = 0;
    last = e.timeStamp;
    if (e.timeStamp < until) { until = e.timeStamp + pause; return 0; }
    sum += e.deltaY * px * (e.ctrlKey ? 2.5 : 1);
    if (Math.abs(sum) < threshold) return 0;
    const d = sum < 0 ? 1 : -1;
    sum = 0; until = e.timeStamp + pause;
    return d;
  };
}
