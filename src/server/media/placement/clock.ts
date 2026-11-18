/**
 * Wall-clock times for an export's keyframes. Part of the placement module (see index.ts); nothing
 * outside it calls this.
 */
import type { Gop, Segments } from "../timeline";

export interface ClockHints {
  /** Keyframe media times where the picture jumps (`jumpsOf`): time is missing there. */
  jumps?: number[];
  /** Known wall-clock ms of some GOPs' keyframes, by GOP index (high GOPs placed on the base). */
  anchors?: Map<number, number>;
}

/** Weights of the search in `keyTimes` that decides which GOPs belong to which segment. */
export interface ClockCosts {
  /** Per second of GOPs that do not fit between their segment's ends. */
  overflow: number;
  /** For a listed segment that holds no exported GOP. */
  emptySegment: number;
  /** For a segment that starts on a keyframe where the picture does not jump (when jumps are known). */
  offJump: number;
  /** Typical length, in seconds, of the gaps the recorder leaves out of a segment. */
  gapSec: number;
  /** Per second a placed GOP sits outside its segment, beyond `anchorSlackSec` at the segment's ends. */
  anchorWeight: number;
  anchorSlackSec: number;
}

/**
 * Wall-clock ms of every GOP's keyframe in an export of [ws, we).
 *
 * The export holds the lead (the last keyframe at or before ws) and then every GOP of the recorder's
 * segments that start before we, in order. Both ends of a segment are exact keyframe times, so the
 * work is deciding which GOPs belong to which segment. A small search tries every split: a segment's
 * GOPs must fit between its ends, a segment starts where the picture jumps (when jumps are known),
 * and anchored GOPs fall inside their segment. Inside a segment, the hidden gaps go at picture jumps,
 * or are spread evenly between known times. Without a segment list the file runs on from the lead.
 */
export function keyTimes(ws: number, we: number, gops: Gop[], segments: Segments | null, hints: ClockHints, costs: ClockCosts): number[] {
  const n = gops.length;
  if (!n) return [];
  const t = gops.map((g) => g.t), lead0 = ws - gops[0].len * 1000;
  const runOn = (from: number, at: number, out: number[], to = n - 1) => { for (let g = from; g <= to; g++) out[g] = at + (t[g] - t[from]) * 1000; return out; };
  const segs = (segments ?? []).filter(([a, b]) => b >= a && a < we).sort((x, y) => x[0] - y[0]);
  if (!segs.length) return runOn(0, lead0, new Array(n));
  const jumps = hints.jumps ? new Set(hints.jumps.map((x) => Math.round(x * 1000))) : null;
  const isJump = (g: number) => !!jumps && jumps.has(Math.round(t[g] * 1000));
  const anchors = hints.anchors ?? new Map<number, number>();
  // The lead's segment is the latest one starting at or before ws, if any; the rest start after it.
  let li = -1;
  for (let k = 0; k < segs.length; k++) if (segs[k][0] <= ws) li = k;
  const lead: [number, number] = li >= 0 ? segs[li] : [lead0, lead0];
  const later = segs.slice(li + 1);
  const K = later.length, leadOpen = lead[1] >= ws; // the lead's segment runs on past ws
  const open = (b: number) => b >= we;
  // Cost of segment `seg` holding GOPs f..l (first: the lead's segment).
  // The lead's keyframe: the last keyframe of a segment that ended before ws, or the latest keyframe
  // at or before ws in the one running across it (taken as one GOP before ws).
  const leadAt = li < 0 ? lead0 : !leadOpen ? lead[1] : Math.min(ws, Math.max(lead[0], lead0));
  const lastBefore = (l: number) => we - gops[l].len * 500;
  // How unlikely it is that `count` hidden gaps add up to `hidden` seconds (gaps run about 3-20 s).
  const holes = (hidden: number, count: number) => count * Math.min(2, Math.log(Math.max(hidden / count, 0.5) / costs.gapSec) ** 2 / 2);
  const cost = (seg: [number, number], f: number, l: number, first: boolean) => {
    if (l < f) return costs.emptySegment;
    // Room for the GOPs: from the first keyframe to the last (about half a GOP before we when the
    // segment runs on past it).
    const [a0, b] = seg, a = first ? leadAt : a0, span = t[l] - t[f];
    const room = ((open(b) ? lastBefore(l) : b) - a) / 1000;
    let c = costs.overflow * Math.max(0, span - room - 0.3 - 0.01 * span);
    if (!first && jumps && !isJump(f)) c += costs.offJump;
    // Time hidden inside the segment sits at holes a few seconds long: at picture jumps when they are
    // known, else at about a third of the boundaries (as measured). A segment of one GOP hides nothing.
    const hidden = Math.max(0, room - span);
    let inside = 0;
    if (jumps) { for (let g = f + 1; g <= l; g++) if (isJump(g)) inside++; } else inside = Math.round(0.3 * (l - f));
    if (!inside) c += hidden > 1.5 + 0.03 * room ? 1 + holes(hidden, 1) : 0;
    else c += holes(hidden, inside);
    // Anchored GOPs fall inside their segment, and the first and last sit at its ends.
    const near = (A: number, x: number) => (costs.anchorWeight * Math.max(0, Math.abs(A - x) - costs.anchorSlackSec * 1000)) / 1000;
    if (!first && anchors.has(f)) c += near(anchors.get(f)!, a);
    if (!open(b) && l > f && anchors.has(l)) c += near(anchors.get(l)!, b);
    for (let g = f; g <= l; g++) { const A = anchors.get(g); if (A == null) continue; const lo = a - 1000, hi = open(b) ? Infinity : b + gops[g].len * 1000 + 1000; c += (costs.anchorWeight * Math.max(0, lo - A, A - hi)) / 1000; }
    return c;
  };
  // best[k][f]: cheapest split with later segment k starting at GOP f (k = 0: the lead's segment).
  const best: number[][] = [], from: number[][] = [];
  // The lead's segment holds GOP 0 and, when it runs on past ws, maybe more.
  best.push(new Array(n + 1).fill(Infinity)); from.push(new Array(n + 1).fill(-1));
  for (let f = 1; f <= (leadOpen ? n : 1); f++) best[0][f] = cost(lead, 0, f - 1, true);
  for (let k = 0; k < K; k++) {
    const row = new Array(n + 1).fill(Infinity), back = new Array(n + 1).fill(-1);
    for (let f = 1; f <= n; f++) {
      if (best[k][f] === Infinity) continue;
      for (let e = f; e <= n; e++) {
        // later[k] holds f..e-1; the next starts at e (or nothing follows when k is the last).
        if (k === K - 1 && e !== n) continue;
        const v = best[k][f] + cost(later[k], f, e - 1, false);
        if (v < row[e]) { row[e] = v; back[e] = f; }
      }
    }
    best.push(row); from.push(back);
  }
  // Walk back the split: start[k] is the first GOP of segment k (0: the lead's).
  const start: number[] = new Array(K + 1);
  let e = n;
  for (let k = K; k >= 1; k--) { const f = from[k][e]; start[k] = f; e = f; }
  start[0] = 0;
  const out: number[] = new Array(n);
  const place = (f: number, l: number, a: number, b: number | null) => {
    if (l < f) return;
    // Known points: the first keyframe, anchors inside, and the last keyframe when the segment closes.
    const pts: [number, number][] = [[f, a]];
    for (let g = f + 1; g <= l; g++) { const A = anchors.get(g); if (A != null) pts.push([g, A]); }
    if (b != null && l > f) pts.push([l, b]);
    // Keep them possible: no two keyframes closer in wall time than in media time.
    for (let i = 1; i < pts.length; i++) pts[i][1] = Math.max(pts[i][1], pts[i - 1][1] + (t[pts[i][0]] - t[pts[i - 1][0]]) * 1000);
    if (b != null) for (let i = pts.length - 2; i >= 1; i--) pts[i][1] = Math.min(pts[i][1], pts[i + 1][1] - (t[pts[i + 1][0]] - t[pts[i][0]]) * 1000);
    for (let i = 0; i < pts.length; i++) {
      const [g0, w0] = pts[i];
      out[g0] = w0;
      if (i + 1 === pts.length) { runOn(g0, w0, out, l); break; }
      const [g1, w1] = pts[i + 1], hidden = Math.max(0, w1 - w0 - (t[g1] - t[g0]) * 1000);
      // Where the hidden time goes: picture jumps between the two points, else every boundary.
      let at = new Set<number>();
      for (let g = g0 + 1; g <= g1; g++) if (isJump(g)) at.add(g);
      if (!at.size) at = new Set(Array.from({ length: g1 - g0 }, (_, k) => g0 + 1 + k));
      const share = hidden / at.size;
      let w = w0;
      for (let g = g0 + 1; g <= g1; g++) { w += (t[g] - t[g - 1]) * 1000 + (at.has(g) ? share : 0); out[g] = w; }
    }
  };
  const leadEnd = K ? start[1] - 1 : n - 1;
  const endOf = (b: number, l: number) => (open(b) ? lastBefore(l) : b);
  place(0, leadEnd, leadAt, leadOpen && leadEnd > 0 ? endOf(lead[1], leadEnd) : null);
  for (let k = 1; k <= K; k++) { const [a, b] = later[k - 1], l = k === K ? n - 1 : start[k + 1] - 1; place(start[k], l, a, endOf(b, l)); }
  return out;
}

/** Wall-clock ms at media time s, given each GOP's keyframe time (`keyTimes`). */
export function clockOf(gops: Gop[], times: number[]): (s: number) => number {
  return (s: number) => {
    if (!gops.length) return 0;
    let a = 0, b = gops.length - 1;
    while (a < b) { const c = (a + b + 1) >> 1; if (gops[c].t <= s + 1e-6) a = c; else b = c - 1; }
    return times[a] + (s - gops[a].t) * 1000;
  };
}

/**
 * Base keyframes where the picture jumps: the frame before a keyframe and the keyframe itself differ
 * far more than neighbouring frames usually do. `diff[j]` is how much frame j differs from frame j-1.
 */
export function jumpsOf(frameT: number[], diff: number[], gops: Gop[], ratio: number): number[] {
  const sorted = diff.slice(1).sort((a, b) => a - b), typical = Math.max(sorted[Math.floor(sorted.length / 2)] ?? 0, 1e-4);
  const out: number[] = [];
  for (const g of gops.slice(1)) {
    const j = frameT.findIndex((t) => Math.abs(t - g.t) < 0.002);
    if (j > 0 && diff[j] / typical > ratio) out.push(g.t);
  }
  return out;
}
