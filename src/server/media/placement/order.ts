/**
 * The playback order of one stretch, from both files' GOPs and times and where the high GOPs were
 * placed by picture. Part of the placement module (see index.ts); nothing outside it calls this.
 *
 * The order is a list of entries (`Entry` in ../timeline.ts): the base alone, the high file over the
 * base, or the high file alone while the base waits (an insert, for a moment the base lacks). Every
 * frame of both files appears once, so nothing recorded is left out. Lead GOPs come first and are
 * flagged, so playing on from the stretch before can skip them.
 */
import type { Entry, Gop } from "../timeline";

export interface BuildInput {
  /**
   * The base file. `jumps`: keyframe times where the picture jumps, a sign that time is missing there
   * (`jumpsOf`); without it, any keyframe may be one.
   */
  base: { gops: Gop[]; duration: number; wall: (s: number) => number; jumps?: number[] };
  /**
   * The high file, where each of its GOPs' keyframes matched in the base (base media time, or null),
   * and how alike GOP g's keyframe is to the base frame at base time s (`matchGops`).
   */
  high?: { gops: Gop[]; duration: number; wall: (s: number) => number; at: (number | null)[]; similar?: (g: number, s: number) => number };
}

/** Weights of `placeUnmatched`, which picks the hole for each high GOP the base lacks. */
export interface HoleWeights {
  /** Picture evidence that a GOP opens a group in a hole (it looks like the frame before the hole). */
  open: number;
  /** Picture evidence that a GOP closes one (it looks like the frame after). */
  close: number;
  /** Cost of splitting a run of GOPs across holes. */
  split: number;
  /** Cost of a place that is no hole (right after the neighbour before). */
  weak: number;
  /** Milliseconds of recorder time that cost as much as one unit of picture evidence. */
  scaleMs: number;
}

/** `slack`: seconds within which a high GOP counts as continuing the one before it. */
export interface OrderSettings { slack: number; holes: HoleWeights }

const EPS = 0.02;

/**
 * The playback order (see the module comment).
 *
 * A matched high GOP is laid over the base from where it matched until it ends, the next GOP's place
 * comes, or (unless the next GOP carries straight on) a base keyframe where the picture jumps, since
 * laying the GOP over a later moment would hide it; whatever is left of the GOP plays on as an insert.
 * Unmatched GOPs are inserted between their matched neighbours, in a hole of the base (`placeUnmatched`).
 */
export function buildEntries({ base, high }: BuildInput, { slack, holes }: OrderSettings): Entry[] {
  const out: Omit<Entry, "at" | "span">[] = [];
  const push = (e: Omit<Entry, "at" | "span">) => { if (e.len > EPS) out.push(e); };
  const leadEnd = base.gops.length > 1 ? base.gops[1].t : base.duration;
  // The high lead never overlays: the stretch before already placed it.
  if (high?.gops.length) push({ kind: "insert", len: high.gops[0].len, base: 0, high: high.gops[0].t, lead: true });
  push({ kind: "base", len: leadEnd, base: 0, lead: true });
  let b = leadEnd;
  if (high) {
    const n = high.gops.length, keys = base.gops.map((g) => g.t);
    // Placements that keep moving forward and stay out of the base lead (which the stretch before shows).
    const at: (number | null)[] = Array.from({ length: n }, (_, g) => (g === 0 ? null : high.at[g] ?? null));
    let last = -Infinity;
    for (let g = 1; g < n; g++) { const v = at[g]; if (v == null) continue; if (v < leadEnd - EPS || v <= last + EPS || v >= base.duration) at[g] = null; else last = v; }
    const nextAt = (g: number) => { for (let k = g + 1; k < n; k++) if (at[k] != null) return at[k]!; return base.duration; };
    const jumps = base.jumps ?? keys.slice(1);
    // Where each matched GOP's overlay ends.
    const end: number[] = [];
    for (let g = 1; g < n; g++) {
      const a = at[g];
      if (a == null) continue;
      let e = Math.min(a + high.gops[g].len, nextAt(g));
      const carriesOn = at[g + 1] != null && Math.abs(at[g + 1]! - a - high.gops[g].len) <= slack;
      if (!carriesOn) { const k = jumps.find((x) => x > a + EPS && x < e - EPS); if (k != null) e = k; }
      end[g] = e;
    }
    const pos = placeUnmatched(base, high, at, end, leadEnd, jumps, holes);
    for (let g = 1; g < n; g++) {
      const gop = high.gops[g], a = at[g];
      if (a == null) {
        if (pos[g] > b) { push({ kind: "base", len: pos[g] - b, base: b }); b = pos[g]; }
        push({ kind: "insert", len: gop.len, base: b, high: gop.t });
        continue;
      }
      if (a > b) { push({ kind: "base", len: a - b, base: b }); b = a; }
      const e = end[g];
      push({ kind: "over", len: e - a, base: a, high: gop.t });
      b = Math.max(b, e);
      if (gop.len - (e - a) > EPS) push({ kind: "insert", len: gop.len - (e - a), base: b, high: gop.t + (e - a) });
    }
  }
  if (b < base.duration - EPS) push({ kind: "base", len: base.duration - b, base: b });
  return withTimes(merge(out), base, high?.wall);
}

/**
 * Where each unmatched high GOP is inserted, in base media time (indexed by GOP; matched GOPs and the
 * lead are left empty).
 *
 * A moment the base lacks belongs in a hole of the base: a keyframe where the picture jumps or where
 * the recorder's times skip ahead. Each stretch of unmatched GOPs between two matched ones is placed
 * as a whole, in order (a Viterbi search over which hole each GOP goes in), weighing two things:
 * - recorder time: how far the GOP's time lies from the time the hole spans;
 * - pictures: a GOP that opens a group in a hole looks like the base frame just before the hole, and
 *   one that closes it like the frame just after (scored against the GOP's usual likeness, so a
 *   still scene, where everything looks alike, leaves the decision to recorder time).
 * Without a hole between the neighbours, the stretch goes right after the GOP before it.
 */
function placeUnmatched(base: BuildInput["base"], high: NonNullable<BuildInput["high"]>, at: (number | null)[], end: number[], leadEnd: number, jumps: number[], weights: HoleWeights): number[] {
  const n = high.gops.length, pos: number[] = [], bw = base.wall, hw = high.wall, sim = high.similar ?? (() => 0);
  const jumpAt = new Set(jumps.map((x) => Math.round(x * 1000)));
  // Holes: where the base could be missing time, with the wall-clock span it skips.
  type Hole = { s: number; from: number; to: number; weak?: true };
  const holes: Hole[] = [];
  for (let k = 1; k < base.gops.length; k++) {
    const p = base.gops[k - 1], s = base.gops[k].t;
    if (s < leadEnd - EPS) continue;
    const from = bw(p.t) + p.len * 1000, to = bw(s);
    if (jumpAt.has(Math.round(s * 1000)) || to - from > 1000) holes.push({ s, from, to: Math.max(from, to) });
  }
  holes.push({ s: base.duration, from: bw(base.duration), to: Infinity });
  const usual = new Map<number, number>();
  const typical = (g: number) => {
    let v = usual.get(g);
    if (v == null) { const xs: number[] = []; for (let s = 0; s < base.duration; s += 0.5) xs.push(sim(g, s)); xs.sort((x, y) => x - y); v = xs[xs.length >> 1] ?? 0; usual.set(g, v); }
    return v;
  };
  const before = (g: number, h: Hole) => sim(g, h.s - 0.05) - typical(g), after = (g: number, h: Hole) => sim(g, h.s + 0.05) - typical(g);
  const { open: OPEN, close: CLOSE, split: SPLIT, weak: WEAK, scaleMs: SCALE } = weights;
  const far = (g: number, h: Hole) => { const w = hw(high.gops[g].t); return Math.max(0, h.from - w, w - h.to) / SCALE; };
  for (let g = 1; g < n; g++) {
    if (at[g] != null) continue;
    let last = g;
    while (last + 1 < n && at[last + 1] == null) last++;
    let prev = g - 1;
    while (prev > 0 && at[prev] == null) prev--;
    const floor = prev > 0 && at[prev] != null ? end[prev] : leadEnd, hi = last + 1 < n ? at[last + 1]! : base.duration;
    const C: Hole[] = holes.filter((h) => h.s >= floor - EPS && h.s <= hi + EPS);
    // The ends of the gap between the neighbours, when the base has no hole there.
    if (!C.some((h) => Math.abs(h.s - floor) < EPS)) C.unshift({ s: floor, from: bw(floor), to: bw(floor), weak: true });
    if (!C.some((h) => Math.abs(h.s - hi) < EPS)) C.push({ s: hi, from: bw(hi), to: bw(hi), weak: true });
    const m = C.length, us = Array.from({ length: last - g + 1 }, (_, i) => g + i);
    const em = (u: number, k: number) => -far(u, C[k]) - (C[k].weak ? WEAK : 0);
    let V = C.map((h, k) => em(us[0], k) + OPEN * before(us[0], h));
    const back: number[][] = [];
    for (let i = 1; i < us.length; i++) {
      const u = us[i], p = us[i - 1], W: number[] = [], B: number[] = [];
      // Best way to have closed a group in an earlier hole.
      let bestPrev = -Infinity, bestK = -1;
      for (let k = 0; k < m; k++) {
        const stay = V[k];
        const open = bestPrev + OPEN * before(u, C[k]) - SPLIT;
        if (stay >= open) { W.push(stay + em(u, k)); B.push(k); } else { W.push(open + em(u, k)); B.push(bestK); }
        const closed = V[k] + CLOSE * after(p, C[k]);
        if (closed > bestPrev) { bestPrev = closed; bestK = k; }
      }
      V = W; back.push(B);
    }
    let k = 0;
    for (let x = 1; x < m; x++) if (V[x] + CLOSE * after(us[us.length - 1], C[x]) > V[k] + CLOSE * after(us[us.length - 1], C[k])) k = x;
    for (let i = us.length - 1; i >= 0; i--) { pos[us[i]] = C[k].s; if (i) k = back[i - 1][k]; }
    g = last;
  }
  return pos;
}

/** Joins neighbours that continue each other, so the player has fewer hand-offs. */
function merge(es: Omit<Entry, "at" | "span">[]) {
  const out: Omit<Entry, "at" | "span">[] = [];
  for (const e of es) {
    const p = out[out.length - 1];
    const sameBase = p && Math.abs(p.base + (p.kind === "insert" ? 0 : p.len) - e.base) < EPS;
    const sameHigh = p && p.high != null && e.high != null && Math.abs(p.high + p.len - e.high) < EPS;
    if (p && p.kind === e.kind && !!p.lead === !!e.lead && sameBase && (e.kind === "base" || sameHigh)) p.len += e.len;
    else out.push({ ...e });
  }
  return out;
}

/**
 * Wall-clock times. Base and overlay entries take theirs from the base, cut where the base skips
 * time so that each one runs at the speed of the clock; inserts take theirs from the high file, kept
 * between their neighbours so the shown time never runs backwards.
 */
function withTimes(es: Omit<Entry, "at" | "span">[], base: BuildInput["base"], highWall?: (s: number) => number): Entry[] {
  const w = base.wall, g = base.gops, skips: number[] = [];
  for (let k = 1; k < g.length; k++) if (w(g[k].t) - w(g[k - 1].t) - g[k - 1].len * 1000 > 500) skips.push(g[k].t);
  const out: Entry[] = [];
  for (const e of es) {
    if (e.kind === "insert") {
      const at = highWall ? highWall(e.high!) : w(e.base);
      out.push({ ...e, at, span: e.len * 1000 });
      continue;
    }
    const cuts = [e.base, ...skips.filter((x) => x > e.base + EPS && x < e.base + e.len - EPS), e.base + e.len];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const s = cuts[k], len = cuts[k + 1] - s;
      out.push({ ...e, base: s, len, ...(e.high != null ? { high: e.high + (s - e.base) } : {}), at: w(s), span: len * 1000 });
    }
  }
  // Inserts sit between the base-anchored entries around them, one after another.
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (e.kind !== "insert") continue;
    const prev = out[i - 1], lo = prev ? prev.at + prev.span : e.at;
    const nx = out.slice(i + 1).find((x) => x.kind !== "insert"), hi = nx ? nx.at : Math.max(lo, e.at + e.span);
    const at = Math.min(Math.max(e.at, lo), hi);
    out[i] = { ...e, at, span: Math.max(0, Math.min(e.span, hi - at)) };
  }
  return out;
}
