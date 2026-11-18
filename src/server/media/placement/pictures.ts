/**
 * Placing high-resolution GOPs on the low-resolution file by comparing pictures. Part of the
 * placement module (see index.ts); nothing outside it calls this.
 *
 * The recorder keeps the two channels separately, with gaps in both, and an export of either one
 * is a plain run of GOPs with no times inside. The high channel's segment list is off by many seconds,
 * so the low file is the timeline, and each high GOP goes where its keyframe looks like a low frame.
 *
 * Pictures are small grayscale thumbnails without the top and bottom bands, where cameras draw their
 * clock and name (drawn at a different size in each channel). Two scores are combined: the picture
 * itself, and what differs from the channel's usual picture (its per-pixel median), which is what
 * tells two moments of a busy room apart when the room itself dominates the picture.
 */

/** Thumbnails: `t[k]` is frame k's time in seconds, its `w * h` gray pixels at `px[k * w * h]`. */
export interface Thumbs { w: number; h: number; t: number[]; px: Uint8Array }

export interface MatchOptions {
  /** Share of rows left out at the top and at the bottom. */
  band: number;
  /** Weight of the moving-parts score against the whole-picture score. */
  motion: number;
  /** Score a match must reach to count on its own. */
  threshold: number;
  /** Lowest score a match may have when its neighbours vouch for it. */
  floor: number;
  /** Reward for a GOP that continues straight on from the one before it. */
  bonus: number;
  /** How far, in seconds, a continuing GOP may sit from where the one before it ends. */
  slack: number;
  /** How much better than anywhere else (more than `apart` seconds away) a lone match must score. */
  margin: number;
  apart: number;
  /** How close to a GOP's best frame another candidate must score to be considered at all. */
  tie: number;
}


/** Where high GOP k landed: low frame `low` (index), or null when no low frame shows it. */
interface Landing { low: number | null; score: number }

/** Unit vectors of each frame's pixels, and of each frame minus the channel's median picture. */
function vectors(f: Thumbs, band: number): { whole: Float32Array[]; moving: Float32Array[] } {
  const n = f.t.length, size = f.w * f.h, r0 = Math.min(Math.round(f.h * band), Math.floor((f.h - 1) / 2)), from = r0 * f.w, to = size - r0 * f.w, len = to - from;
  const median = new Float32Array(len);
  if (n) {
    const hist = new Uint32Array(256), half = n / 2;
    for (let p = 0; p < len; p++) {
      hist.fill(0);
      for (let k = 0; k < n; k++) hist[f.px[k * size + from + p]]++;
      let acc = 0, v = 0;
      while (v < 255 && acc + hist[v] < half) acc += hist[v++];
      median[p] = v;
    }
  }
  const unit = (x: Float32Array) => {
    let m = 0; for (let p = 0; p < len; p++) m += x[p];
    m /= len; let s = 0;
    for (let p = 0; p < len; p++) { x[p] -= m; s += x[p] * x[p]; }
    const k = s > 1e-6 ? 1 / Math.sqrt(s) : 0;
    for (let p = 0; p < len; p++) x[p] *= k;
    return x;
  };
  const whole: Float32Array[] = [], moving: Float32Array[] = [];
  for (let k = 0; k < n; k++) {
    const a = new Float32Array(len), b = new Float32Array(len), o = k * size + from;
    for (let p = 0; p < len; p++) { a[p] = f.px[o + p]; b[p] = f.px[o + p] - median[p]; }
    whole.push(unit(a)); moving.push(unit(b));
  }
  return { whole, moving };
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let p = 0; p < a.length; p++) s += a[p] * b[p]; return s; };

/** Scores of every high keyframe against every low frame, row by row (`n * m`). */
function scores(high: Thumbs, low: Thumbs, o: Pick<MatchOptions, "band" | "motion">): Float32Array {
  if (high.w !== low.w || high.h !== low.h) throw new Error("thumbnails differ in size");
  const H = vectors(high, o.band), L = vectors(low, o.band), n = high.t.length, m = low.t.length, out = new Float32Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) out[i * m + j] = (o.motion < 1 ? (1 - o.motion) * dot(H.whole[i], L.whole[j]) : 0) + (o.motion > 0 ? o.motion * dot(H.moving[i], L.moving[j]) : 0);
  return out;
}

/**
 * The best placement of high GOPs (in order, `gap[k]` seconds from keyframe k to the next) on low
 * frames at times `lowT`, given their scores.
 *
 * Each GOP may only land on a peak of its own scores (the best frame within `apart` seconds), so the
 * search can never pull a GOP off the frame that looks most like it. Placements only move forward in
 * time. A GOP placed about `gap` after the previous one earns `bonus`: runs of GOPs that agree with
 * each other beat scattered look-alikes, and a GOP that only scores fairly (at least `floor`) is kept
 * when it continues a run. A GOP that stands alone must reach `threshold` and beat every frame more
 * than `apart` seconds away by `margin`. Anything else stays unplaced, which costs at worst a moment
 * shown twice, never a moment lost.
 */
function bestPath(S: Float32Array, lowT: number[], gap: number[], o: MatchOptions): Landing[] {
  const n = gap.length, m = lowT.length;
  const out: Landing[] = gap.map(() => ({ low: null, score: 0 }));
  if (!n || !m) return out;
  // Peaks: frames that beat every other frame within `apart` seconds, best first, a few per GOP.
  const peaks: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = S.subarray(i * m, (i + 1) * m), list: number[] = [];
    for (let j = 0, a = 0, b = 0; j < m; j++) {
      if (row[j] < o.floor) continue;
      while (lowT[a] < lowT[j] - o.apart) a++;
      while (b + 1 < m && lowT[b + 1] <= lowT[j] + o.apart) b++;
      let top = true;
      for (let q = a; q <= b && top; q++) if (row[q] > row[j] || (row[q] === row[j] && q < j)) top = false;
      if (top) list.push(j);
    }
    list.sort((x, y) => row[y] - row[x]);
    peaks.push(list.filter((j) => row[j] >= row[list[0]] - o.tie).slice(0, 6));
  }
  // Longest-path over (GOP, peak) nodes in GOP order; a node may follow any earlier node that sits
  // earlier in low time. Small enough (GOPs x 6) to compare every pair.
  type Node = { i: number; j: number; s: number; best: number; prev: number };
  const nodes: Node[] = [];
  for (let i = 0; i < n; i++) for (const j of peaks[i]) nodes.push({ i, j, s: S[i * m + j], best: 0, prev: -1 });
  const joins = (a: Node, b: Node) => b.i === a.i + 1 && Math.abs(lowT[b.j] - lowT[a.j] - gap[a.i]) <= o.slack;
  let end = -1;
  for (let x = 0; x < nodes.length; x++) {
    const b = nodes[x];
    b.best = b.s - o.threshold;
    for (let y = 0; y < x; y++) {
      const a = nodes[y];
      if (a.i >= b.i || lowT[a.j] >= lowT[b.j] - 0.3) continue;
      const v = a.best + b.s - o.threshold + (joins(a, b) ? o.bonus : 0);
      if (v > b.best) { b.best = v; b.prev = y; }
    }
    if (end < 0 || b.best > nodes[end].best) end = x;
  }
  if (end < 0 || nodes[end].best <= 0) return out;
  // Drop a losing prefix: the chain may have started with a placement that only paid for itself later.
  for (let x = end; x >= 0; x = nodes[x].prev) out[nodes[x].i] = { low: nodes[x].j, score: nodes[x].s };
  // A lone placement (no neighbour continuing into or out of it) must stand out on its own.
  const joined = (a: number, b: number) => { const pa = out[a]?.low, pb = out[b]?.low; return pa != null && pb != null && Math.abs(lowT[pb] - lowT[pa] - gap[a]) <= o.slack; };
  for (let i = 0; i < n; i++) {
    const p = out[i];
    if (p.low == null || joined(i - 1, i) || joined(i, i + 1)) continue;
    let alt = -1;
    for (let j = 0; j < m; j++) if (Math.abs(lowT[j] - lowT[p.low]) > o.apart) alt = Math.max(alt, S[i * m + j]);
    if (p.score < o.threshold || p.score - alt < o.margin) out[i] = { low: null, score: p.score };
  }
  return out;
}

/**
 * Where each high GOP lands in the base, in base media time, or null when no base frame shows it, and
 * how alike a GOP's keyframe and the base frame at a given time are (for placing unmatched GOPs).
 * `keys` are thumbnails of the high file's keyframes, `gops` its GOPs (`gopsOf`); they are paired by time.
 */
export function matchGops(keys: Thumbs, low: Thumbs, gops: { t: number; len: number }[], o: MatchOptions): { at: (number | null)[]; similar: (g: number, s: number) => number } {
  const size = keys.w * keys.h, row: number[] = [];
  for (const g of gops) { let k = -1; for (let i = 0; i < keys.t.length; i++) if (Math.abs(keys.t[i] - g.t) < 0.02) { k = i; break; } row.push(k); }
  const have = row.map((k, g) => [k, g] as const).filter(([k]) => k >= 0);
  if (!have.length || !low.t.length) return { at: gops.map(() => null), similar: () => 0 };
  const px = new Uint8Array(have.length * size);
  have.forEach(([k], r) => px.set(keys.px.subarray(k * size, (k + 1) * size), r * size));
  const S = scores({ w: keys.w, h: keys.h, t: have.map(([k]) => keys.t[k]), px }, low, o), m = low.t.length;
  const P = bestPath(S, low.t, have.map(([, g]) => gops[g].len), o);
  const at: (number | null)[] = gops.map(() => null), rowOf = new Map<number, number>();
  have.forEach(([, g], r) => { rowOf.set(g, r); const j = P[r].low; at[g] = j == null ? null : low.t[j]; });
  const frameAt = (s: number) => { let a = 0, b = m - 1; while (a < b) { const c = (a + b + 1) >> 1; if (low.t[c] <= s) a = c; else b = c - 1; } return a; };
  return { at, similar: (g, s) => { const r = rowOf.get(g); return r == null ? 0 : S[r * m + frameAt(s)]; } };
}

/** How much each frame differs from the one before it (0 for the first), on the whole picture. */
export function frameDiffs(f: Thumbs, band: number): number[] {
  const { whole } = vectors(f, band);
  return whole.map((v, j) => (j ? 1 - dot(whole[j - 1], v) : 0));
}
