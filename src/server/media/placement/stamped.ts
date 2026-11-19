/**
 * Placing a stretch whose GOPs the recorder stamped with their times (Protect's playback stream gives
 * one stamp per GOP). Part of the placement module (see index.ts); nothing outside it calls this.
 *
 * The base's stamps are the timeline: they follow the camera to within about a second and show every
 * hole in the recording. The high channel's stamps cannot be used as they are: on third-party cameras
 * the recorder's clock for that channel runs ahead of the camera, so a GOP's stamp is late by anything
 * from a second to half a minute (its lag). Measured on real footage (`scripts/adaptive-eval`), the
 * lag behaves like this: GOPs that follow on keep it or add the gap between their stamps; across a
 * stall (a few seconds without footage) it grows by about a quarter of the stall; and at about 32
 * seconds the recorder starts again near zero, after a hole of half a minute. What the stamps do say
 * for certain is the order of the GOPs and that no GOP was recorded after its stamp.
 *
 * So the one thing left to find is how late each high GOP's stamp runs (its lag). `highTimes` finds
 * it with a search over the GOPs in order: a GOP either carries on from the one before (the lag grows
 * by the gap between their stamps) or starts again after a break, and each GOP is scored by how much
 * its keyframe looks like the base frame at the time that lag gives it, or by a fixed score where the
 * base has nothing. A run of GOPs is then one rigid piece, so a few clear pictures place all of it.
 * `orderByTime` then walks both timelines: the high file over the base where both have the moment,
 * either one alone elsewhere.
 */
import type { Entry, Gop } from "../timeline";

export interface LagSettings {
  /** The earliest and latest a high GOP's stamp may run behind the base's clock, in seconds. */
  minSec: number;
  maxSec: number;
  /** Step of the search, in seconds. */
  stepSec: number;
  /**
   * Score of putting a GOP where the base has no frame. A base frame of the same moment scores about
   * 0.8 to 1 and one a few seconds away seldom over 0.7, so a base frame must look more alike than
   * this to take the GOP, and one that looks less alike speaks against the GOP lying there.
   */
  absent: number;
  /** Cost of a break between two GOPs whose stamps follow on from each other. */
  breakCost: number;
  /** A gap between stamps longer than this many seconds is a break for certain: the stream stalled. */
  stallSec: number;
  /**
   * Without pictures to go by, the lag after a break is the lag before it plus this share of the gap
   * between the stamps (the recorder's clock keeps running ahead while the stream stalls), and
   * `drift` is the cost per second of straying above that. Below it costs `shrink` per second: the
   * lag was not seen to fall except when the recorder starts again.
   */
  grow: number;
  drift: number;
  shrink: number;
  /**
   * The recorder starting again: from a lag of at least `resetFromSec`, or after `pauseSec` without
   * footage, a break may instead land near `resetToSec` (`drift` per second away from it) at the
   * cost `reset`.
   */
  resetFromSec: number;
  pauseSec: number;
  resetToSec: number;
  reset: number;
  /** Stamps of two base GOPs this close to following on (as a share of the GOP's length) count as following on. */
  join: number;
}

/** One base GOP on the timeline: media time and length in seconds, wall-clock start and span in ms. */
export interface Span { t: number; len: number; at: number; span: number }

/** True when `stamps` can serve as the times of `gops`: one each, in order. */
export function usable(gops: Gop[], stamps: number[] | undefined): stamps is number[] {
  if (!stamps || stamps.length !== gops.length || !gops.length) return false;
  for (let k = 0; k < stamps.length; k++) if (!Number.isFinite(stamps[k]) || (k && stamps[k] <= stamps[k - 1])) return false;
  return true;
}

/**
 * The base's GOPs on the timeline. A GOP whose stamp follows the one before within `join` of its
 * length runs up to it, so stamps a little early or late leave no sliver of missing or doubled time;
 * a larger gap is a hole in the recording.
 */
export function baseSpans(gops: Gop[], stamps: number[], join: number): Span[] {
  return gops.map((g, k) => {
    const nominal = g.len * 1000, next = stamps[k + 1];
    const follows = next != null && Math.abs(next - (stamps[k] + nominal)) <= join * nominal;
    return { t: g.t, len: g.len, at: stamps[k], span: Math.max(1, follows ? next - stamps[k] : next != null ? Math.min(nominal, next - stamps[k]) : nominal) };
  });
}

/** The span showing wall-clock `ms`, or null in a hole. */
function spanAt(spans: Span[], ms: number): Span | null {
  let a = 0, b = spans.length - 1;
  if (b < 0 || ms < spans[0].at) return null;
  while (a < b) { const c = (a + b + 1) >> 1; if (spans[c].at <= ms) a = c; else b = c - 1; }
  return ms < spans[a].at + spans[a].span ? spans[a] : null;
}

/** Base media time showing wall-clock `ms`, or null in a hole. */
export function mediaAt(spans: Span[], ms: number): number | null {
  const s = spanAt(spans, ms);
  return s ? s.t + ((ms - s.at) / s.span) * s.len : null;
}

export interface HighTimes {
  /** Wall-clock ms of each high GOP's keyframe. */
  times: number[];
  /** How many seconds each GOP's stamp ran late. */
  lag: number[];
  /** GOPs whose keyframe was scored against a base frame and looked more alike than `absent`. */
  seen: boolean[];
}

/**
 * When each high GOP was really recorded (see the module comment). `keyOf[g]` is the picture of GOP
 * g's keyframe or null, `frameAt(ms)` the base frame showing a wall-clock time or null, and
 * `like(key, frame)` how alike the two are.
 */
export function highTimes(gops: Gop[], stamps: number[], keyOf: (number | null)[], frameAt: (ms: number) => number | null, like: (key: number, frame: number) => number, s: LagSettings): HighTimes {
  const G = gops.length, n = Math.max(1, Math.round((s.maxSec - s.minSec) / s.stepSec) + 1);
  if (!G) return { times: [], lag: [], seen: [] };
  const lagOf = (i: number) => s.minSec + i * s.stepSec;
  const fitAt = (g: number, ms: number) => {
    const key = keyOf[g], f = key == null ? null : frameAt(ms);
    return f == null ? s.absent : like(key!, f);
  };
  const score = (g: number, lagSec: number) => fitAt(g, stamps[g] - lagSec * 1000);
  let V = Float64Array.from({ length: n }, (_, i) => score(0, lagOf(i)));
  const from: Int32Array[] = [], carried: Uint8Array[] = [];
  for (let g = 1; g < G; g++) {
    // Seconds between the end of the GOP before (by its stamp) and this one's stamp.
    const gap = (stamps[g] - stamps[g - 1]) / 1000 - gops[g - 1].len, shift = Math.round(gap / s.stepSec), lo = Math.floor(gap / s.stepSec + 1e-6), hi = Math.ceil(gap / s.stepSec - 1e-6);
    const W = new Float64Array(n).fill(-Infinity), F = new Int32Array(n).fill(-1), C = new Uint8Array(n);
    const breakCost = gap > s.stallSec || gap < -s.stepSec ? 0 : s.breakCost, expect = Math.max(0, gap) * s.grow;
    for (let j = 0; j < n; j++) {
      // Carrying on: the same clock, so the lag grows by the gap (to either step beside it, so that
      // rounding to steps cannot add up along a run).
      if (gap <= s.stallSec) for (const i0 of [j - lo, j - hi]) if (i0 >= 0 && i0 < n && V[i0] > W[j]) { W[j] = V[i0]; F[j] = i0; C[j] = 1; }
      // A break: this GOP starts later than the one before ended, by at least one step.
      for (let i = Math.max(0, j - shift + 1); i < n; i++) {
        const off = (j - i) * s.stepSec - expect, stall = breakCost + (off < 0 ? -off * s.shrink : off * s.drift);
        const v = V[i] - (lagOf(i) >= s.resetFromSec || gap >= s.pauseSec ? Math.min(stall, s.reset + s.drift * Math.abs(lagOf(j) - s.resetToSec)) : stall);
        if (v > W[j]) { W[j] = v; F[j] = i; C[j] = 0; }
      }
      if (W[j] > -Infinity) W[j] += score(g, lagOf(j));
    }
    V = W; from.push(F); carried.push(C);
  }
  let j = 0;
  for (let i = 1; i < n; i++) if (V[i] > V[j]) j = i;
  const idx = new Array<number>(G), joins = new Array<boolean>(G).fill(false);
  for (let g = G - 1; g >= 0; g--) { idx[g] = j; if (g) { joins[g] = carried[g - 1][j] === 1; j = from[g - 1][j]; } }

  // Each run of GOPs that carry on is one rigid piece: nudge it to the frame that fits best, then lay
  // its GOPs end to end, never before the run before it ends.
  const times = new Array<number>(G), fine = 1 / 30;
  let floor = -Infinity;
  for (let a = 0; a < G; ) {
    let b = a;
    while (b + 1 < G && joins[b + 1]) b++;
    const start = stamps[a] - lagOf(idx[a]) * 1000, offs: number[] = [];
    let o = 0;
    for (let g = a; g <= b; g++) { offs.push(o); o += gops[g].len * 1000; }
    const fit = (d: number) => { let v = 0; for (let g = a; g <= b; g++) v += fitAt(g, start + d + offs[g - a]); return v; };
    let best = 0, bestV = fit(0);
    for (let d = -s.stepSec; d <= s.stepSec + 1e-9; d += fine) { const v = fit(d * 1000); if (v > bestV + 1e-9) { bestV = v; best = d * 1000; } }
    const at = Math.max(start + best, floor);
    for (let g = a; g <= b; g++) times[g] = at + offs[g - a];
    floor = at + o;
    a = b + 1;
  }
  const seen = times.map((t, g) => keyOf[g] != null && frameAt(t) != null && fitAt(g, t) > s.absent);
  return { times, lag: times.map((t, g) => (stamps[g] - t) / 1000), seen };
}

const EPS = 0.02;

/**
 * The playback order of [startMs, endMs) from both timelines: `over` where both files have the
 * moment, `base` or `insert` where one does. Nothing outside the window is played, except the part of
 * the base's first GOP before it, flagged as the lead (the stretch before shows it). High GOPs from
 * before or after the window belong to the stretches there.
 */
export function orderByTime(startMs: number, endMs: number, base: Span[], high?: { gops: Gop[]; times: number[] }): Entry[] {
  const hi: Span[] = high ? high.gops.map((g, k) => ({ t: g.t, len: g.len, at: high.times[k], span: g.len * 1000 })) : [];
  const cuts = new Set<number>([startMs, endMs]);
  for (const x of base) { cuts.add(x.at); cuts.add(x.at + x.span); }
  for (const x of hi) { cuts.add(x.at); cuts.add(x.at + x.span); }
  const xs = [...cuts].sort((a, b) => a - b), out: Entry[] = [];
  // Where the base waits during an insert: the next base frame to play.
  let cursor = mediaAt(base, startMs) ?? base.find((x) => x.at >= startMs)?.t ?? (base.length ? base[base.length - 1].t + base[base.length - 1].len : 0);
  const push = (e: Entry) => {
    if (e.len <= EPS) return;
    const p = out[out.length - 1];
    const joins = p && p.kind === e.kind && !!p.lead === !!e.lead && Math.abs(p.at + p.span - e.at) < 1
      && (e.kind === "insert" || Math.abs(p.base + p.len - e.base) < EPS) && (e.kind === "base" || Math.abs(p.high! + p.len - e.high!) < EPS);
    if (joins) { p.len += e.len; p.span += e.span; } else out.push(e);
  };
  for (let k = 0; k + 1 < xs.length; k++) {
    const x = xs[k], y = xs[k + 1], mid = (x + y) / 2;
    if (y - x < 1 || mid >= endMs) continue;
    const b = spanAt(base, mid), h = mid < startMs ? null : spanAt(hi, mid);
    if (mid < startMs) {
      if (b) push({ kind: "base", len: ((y - x) / b.span) * b.len, base: b.t + ((x - b.at) / b.span) * b.len, at: x, span: y - x, lead: true });
      continue;
    }
    if (b) {
      const at = b.t + ((x - b.at) / b.span) * b.len, len = ((y - x) / b.span) * b.len;
      push(h ? { kind: "over", len, base: at, high: h.t + (x - h.at) / 1000, at: x, span: y - x } : { kind: "base", len, base: at, at: x, span: y - x });
      cursor = at + len;
    } else if (h) push({ kind: "insert", len: (y - x) / 1000, base: cursor, high: h.t + (x - h.at) / 1000, at: x, span: y - x });
  }
  return out;
}
