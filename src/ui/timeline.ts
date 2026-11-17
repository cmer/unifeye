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
