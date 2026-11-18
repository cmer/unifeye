import { describe, expect, it } from "vitest";
import { PLACEMENT, placeStretch, type Thumbs } from "@/server/media/placement";
import type { Entry, Gop } from "@/server/media/timeline";

/**
 * The placement module through its interface (`placeStretch`), on made-up recordings of made-up
 * scenes. `tests/recorded.test.ts` runs it inside `fetchRecorded`; `scripts/adaptive-eval` measures it
 * on real footage.
 *
 * A scene gives the picture at every moment. A channel's export is runs of recorded time as GOPs back
 * to back, with thumbnails of what the scene showed, and the segment list the recorder would give for
 * it (first keyframe to last keyframe of each run). Every frame's true time is known, so a test can
 * check what the player would show.
 */

const A = 1_800_000_000_000, WINDOW = { startMs: A, endMs: A + 60_000 };
const W = 32, H = 24, FPS = 5;

/** A picture at `s` seconds after A, on channel `ch`. */
type Scene = (s: number, ch: "lo" | "hi") => Uint8Array;

/** W x H values in [-80, 80), the same for the same `k`. */
function noise(k: number): Float32Array {
  let a = Math.imul(k | 0, 0x9e3779b1) ^ 0x5bd1e995;
  return Float32Array.from({ length: W * H }, () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * 160 - 80;
  });
}

/**
 * A busy room: the picture changes smoothly and never repeats (a blend of random pictures, a new one
 * every 2 s). `like(s)` gives the moment that moment `s` looks like, to make look-alikes.
 */
function busy(like: (s: number) => number = (s) => s): Scene {
  const beats = new Map<number, Float32Array>();
  const beat = (k: number) => { let p = beats.get(k); if (!p) beats.set(k, (p = noise(k))); return p; };
  return (s) => {
    const x = like(s) / 2, k = Math.floor(x), f = x - k, a = beat(k), b = beat(k + 1);
    return Uint8Array.from(a, (v, i) => Math.round(128 + (1 - f) * v + f * b[i]));
  };
}

/** A room where nothing moves: the same picture with a little sensor noise, different on each channel. */
const still: Scene = (s, ch) => {
  const room = noise(-1), grain = noise(Math.round(s * 1000) + (ch === "hi" ? 1e8 : 0));
  return Uint8Array.from(room, (v, i) => Math.round(128 + v + grain[i] * 0.03));
};

/**
 * One channel's export of the window: runs of recorded time ([start ms, GOP count]) as GOPs of `len`
 * seconds back to back. Like the recorder's, it starts with the last keyframe at or before A.
 */
function channel(ch: "lo" | "hi", scene: Scene, runs: [number, number][], len: number) {
  const gops: Gop[] = [], truth: number[] = [];
  let end = 0;
  for (const [at, count] of runs) for (let k = 0; k < count; k++) { gops.push({ t: end, len, hash: `${ch}${at + k * len * 1000}` }); truth.push(at + k * len * 1000); end += len; }
  /** The true wall-clock ms at media time s. */
  const wall = (s: number) => { const g = Math.min(gops.length - 1, Math.floor(s / len + 1e-9)); return truth[g] + (s - gops[g].t) * 1000; };
  const thumbs = (ts: number[]): Thumbs => {
    const px = new Uint8Array(ts.length * W * H);
    ts.forEach((s, k) => px.set(scene((wall(s) - A) / 1000, ch), k * W * H));
    return { w: W, h: H, t: ts, px };
  };
  const segments = runs.map(([at, count]): [number, number] => [at, at + (count - 1) * len * 1000]);
  return {
    gops, end, wall, truth, segments,
    frames: () => thumbs(Array.from({ length: Math.round(end * FPS) }, (_, k) => k / FPS)),
    keys: () => thumbs(gops.map((g) => g.t)),
  };
}
type Channel = ReturnType<typeof channel>;

const asBase = (c: Channel, o: { pictures?: boolean; segments?: [number, number][] | null } = {}) =>
  ({ gops: c.gops, end: c.end, segments: o.segments === undefined ? c.segments : o.segments, frames: o.pictures === false ? undefined : c.frames() });
const asHigh = (c: Channel, segments: [number, number][] | null = c.segments) => ({ gops: c.gops, end: c.end, segments, keys: c.keys() });

/** kind, base, high, len of each entry. */
const summary = (es: Entry[]) => es.map((e) => [e.kind, round(e.base), e.high == null ? null : round(e.high), round(e.len)]);
const round = (x: number) => Math.round(x * 100) / 100;

/** Every frame of both files plays exactly once, in file order. */
function expectComplete(es: Entry[], base: Channel, high?: Channel) {
  let b = 0, h = 0;
  for (const e of es) {
    if (e.kind !== "insert") { expect(e.base).toBeCloseTo(b, 3); b = e.base + e.len; }
    if (e.high != null) { expect(e.high).toBeCloseTo(h, 3); h = e.high + e.len; }
  }
  expect(b).toBeCloseTo(base.end, 3);
  expect(h).toBeCloseTo(high?.end ?? 0, 3);
}

/** The true time of what the player shows every tenth of a second, after the leads. */
function shown(es: Entry[], base: Channel, high?: Channel): number[] {
  const out: number[] = [];
  for (const e of es) {
    if (e.lead) continue;
    for (let x = 0; x < e.len - 1e-6; x += 0.1) out.push(e.kind === "base" ? base.wall(e.base + x) : high!.wall(e.high! + x));
  }
  return out;
}

/** How far each shown moment falls behind the latest one shown before it, in seconds (the worst). */
const worstStepBack = (ts: number[]) => { let peak = -Infinity, worst = 0; for (const t of ts) { worst = Math.max(worst, (peak - t) / 1000); peak = Math.max(peak, t); } return worst; };

describe("placing the base alone", () => {
  it("runs on from one GOP before the window when the recorder lists no segments", () => {
    const lo = channel("lo", busy(), [[A, 4]], 1);
    const { entries, trace } = placeStretch(WINDOW, asBase(lo, { segments: null, pictures: false }));
    expect(trace.baseTimes).toEqual([A - 1000, A, A + 1000, A + 2000]);
    expect(summary(entries)).toEqual([["base", 0, null, 1], ["base", 1, null, 3]]);
  });

  it("puts each GOP in its segment, and cuts the order where time skips so each entry runs with the clock", () => {
    const lo = channel("lo", busy(), [[A, 20], [A + 30_000, 30]], 1);
    for (const pictures of [true, false]) {
      const { entries, trace } = placeStretch(WINDOW, asBase(lo, { pictures }));
      expect(trace.baseTimes).toEqual(lo.truth);
      expect(entries.map((e) => [e.kind, e.base, e.len, e.at, e.span, !!e.lead])).toEqual([
        ["base", 0, 1, A, 1000, true], ["base", 1, 19, A + 1000, 19_000, false], ["base", 20, 30, A + 30_000, 30_000, false],
      ]);
    }
  });

  it("places the lead at the end of a segment that ended before the window", () => {
    const lo = channel("lo", busy(), [[A - 30_000, 1], [A + 10_000, 10]], 1);
    const { trace } = placeStretch(WINDOW, asBase(lo, { segments: [[A - 60_000, A - 30_000], [A + 10_000, A + 19_000]] }));
    expect(trace.baseTimes).toEqual(lo.truth);
  });

  it("puts time that a segment hides where the picture jumps", () => {
    // 10 s recorded, 11 s not, 10 s recorded, listed as one segment.
    const lo = channel("lo", busy(), [[A, 10], [A + 21_000, 10]], 1), segments: [number, number][] = [[A, A + 30_000]];
    const { entries, trace } = placeStretch(WINDOW, asBase(lo, { segments }));
    expect(trace.jumps).toEqual([10]);
    expect(trace.baseTimes).toEqual(lo.truth);
    expect(entries.map((e) => [e.base, e.at])).toEqual([[0, A], [1, A + 1000], [10, A + 21_000]]);
    // Without pictures the hidden time is spread out.
    const blind = placeStretch(WINDOW, asBase(lo, { segments, pictures: false }));
    expect(blind.trace.jumps).toEqual([]);
    expect(blind.trace.baseTimes[10]).toBeGreaterThan(A + 10_000);
    expect(blind.trace.baseTimes[10]).toBeLessThan(A + 21_000);
  });
});

describe("placing an adaptive recording", () => {
  // Low resolution (1 s GOPs) misses 10 s of motion; high resolution (2 s GOPs, as the recorder
  // stores them) runs from 5 s before that hole to 1 s after, then again 10 s later. Its recorder
  // list hides the gap between the two runs, and its lead is long before.
  const LOW: [number, number][] = [[A, 20], [A + 30_000, 30]];
  const HIGH: [number, number][] = [[A - 300_000, 1], [A + 15_000, 8], [A + 41_000, 3]];
  const HIGH_LIST: [number, number][] = [[A - 300_000, A - 300_000], [A + 15_000, A + 45_000]];

  it("lays the high file over the moments the base shows and inserts the moments it lacks", () => {
    const lo = channel("lo", busy(), LOW, 1), hi = channel("hi", busy(), HIGH, 2);
    const { entries, trace } = placeStretch(WINDOW, asBase(lo), asHigh(hi, HIGH_LIST));
    expect(trace.high!.matched).toEqual([null, 15, 17, 19, null, null, null, null, null, 31, 33, 35]);
    expect(summary(entries)).toEqual([
      ["insert", 0, 0, 2], ["base", 0, null, 1], ["base", 1, null, 14],
      // The GOP at 19 s would run past the base's jump at 20 s; the rest of it plays on alone.
      ["over", 15, 2, 5], ["insert", 20, 7, 11],
      ["base", 20, null, 11], ["over", 31, 18, 6], ["base", 37, null, 13],
    ]);
    expectComplete(entries, lo, hi);
    // Forward in time, but for the second both files hold (the high GOP that ends the hole runs into it).
    expect(worstStepBack(shown(entries, lo, hi))).toBeLessThanOrEqual(1.01);
    // Each entry carries the time it shows.
    for (const e of entries.filter((x) => !x.lead && x.kind !== "insert")) expect(e.at).toBe(lo.wall(e.base));
  });

  it("pins the high file's times with the GOPs it lays over, where its segment list hides a gap", () => {
    const lo = channel("lo", busy(), LOW, 1), hi = channel("hi", busy(), HIGH, 2);
    const { trace } = placeStretch(WINDOW, asBase(lo), asHigh(hi, HIGH_LIST));
    for (const g of [1, 2, 3, 9, 10, 11]) expect(trace.high!.times[g]).toBe(hi.truth[g]);
    // Without base pictures nothing is laid over: the list's hidden 10 s is spread out instead.
    const blind = placeStretch(WINDOW, asBase(lo, { pictures: false }), asHigh(hi, HIGH_LIST));
    expect(blind.trace.high!.matched.every((a) => a == null)).toBe(true);
    expect(blind.trace.high!.times[9]).toBeLessThan(hi.truth[9] - 1000);
    expectComplete(blind.entries, lo, hi);
  });

  it("only moves forward: a later moment that looks like an earlier one goes on the later one", () => {
    // 41-47 s looks like 11-17 s, and the base shows both.
    const scene = busy((s) => (s >= 41 && s < 47 ? s - 30 : s));
    const lo = channel("lo", scene, LOW, 1), hi = channel("hi", scene, HIGH, 2);
    const { entries, trace } = placeStretch(WINDOW, asBase(lo), asHigh(hi, HIGH_LIST));
    expect(trace.high!.matched.slice(9)).toEqual([31, 33, 35]);
    expect(trace.high!.similar(9, 11)).toBeCloseTo(trace.high!.similar(9, 31), 2);
    expect(worstStepBack(shown(entries, lo, hi))).toBeLessThanOrEqual(1.01);
  });

  it("lays a GOP that stands alone over the base only when no other moment looks like it", () => {
    // The base lacks 10-30 s, which the high file fills; its GOP at 38 s has no neighbour on the base.
    const low: [number, number][] = [[A, 10], [A + 30_000, 14], [A + 48_000, 12]];
    const runs: [number, number][] = [[A - 300_000, 1], [A + 11_000, 9], [A + 38_000, 1]];
    const one = (scene: Scene) => {
      const lo = channel("lo", scene, low, 1), hi = channel("hi", scene, runs, 2);
      const placed = placeStretch(WINDOW, asBase(lo), asHigh(hi));
      expectComplete(placed.entries, lo, hi);
      return placed;
    };
    const plain = one(busy());
    expect(plain.trace.high!.matched).toEqual([null, null, null, null, null, null, null, null, null, null, 18]);
    expect(summary(plain.entries).filter(([k]) => k === "over")).toEqual([["over", 18, 20, 2]]);
    // 38-40 s looks just like 4-6 s: rather than guess, the GOP plays on its own (its moment shows twice).
    const alike = one(busy((s) => (s >= 38 && s < 40 ? s - 34 : s)));
    expect(alike.trace.high!.matched.every((a) => a == null)).toBe(true);
    expect(alike.entries.some((e) => e.kind === "over")).toBe(false);
  });

  it("leaves a still scene to the recorder's times, since every moment looks alike", () => {
    const lo = channel("lo", still, LOW, 1), hi = channel("hi", still, HIGH, 2);
    const { entries, trace } = placeStretch(WINDOW, asBase(lo), asHigh(hi, HIGH_LIST));
    expect(trace.high!.matched.every((a) => a == null)).toBe(true);
    expect(entries.some((e) => e.kind === "over")).toBe(false);
    // Inserted in the base's hole, which their times are closest to.
    expect(summary(entries).filter(([k], i) => k === "insert" && i > 0)).toEqual([["insert", 20, 2, 22]]);
    expectComplete(entries, lo, hi);
  });

  it("weighs the recorder's times against how the pictures continue at each hole's edges", () => {
    // Two holes in the base: 10-20 s and 30-40 s. The high run fills the second, but its recorder
    // times (21-27 s) sit between the two.
    const lo = channel("lo", busy(), [[A, 10], [A + 20_000, 10], [A + 40_000, 20]], 1);
    const hi = channel("hi", busy(), [[A - 300_000, 1], [A + 31_000, 4]], 2);
    const list: [number, number][] = [[A - 300_000, A - 300_000], [A + 21_000, A + 27_000]];
    const at = (settings = PLACEMENT) => {
      const { entries } = placeStretch(WINDOW, asBase(lo), asHigh(hi, list), settings);
      expectComplete(entries, lo, hi);
      return entries.filter((e) => e.kind === "insert" && !e.lead).map((e) => e.base);
    };
    // Its first picture carries on from the base's last frame before the second hole.
    expect(at()).toEqual([20]);
    // Without the pictures, the times alone pick the first.
    expect(at({ ...PLACEMENT, holes: { ...PLACEMENT.holes, open: 0, close: 0 } })).toEqual([10]);
  });

  it("pairs each keyframe with its picture once and counts what does not pair", () => {
    const lo = channel("lo", busy(), LOW, 1), hi = channel("hi", busy(), HIGH, 2);
    const whole = placeStretch(WINDOW, asBase(lo), asHigh(hi, HIGH_LIST)).trace;
    expect(whole.baseFrames).toEqual(lo.gops.map((g) => g.t * FPS));
    expect(whole.high!.keys).toEqual(hi.gops.map((_, g) => g));
    expect(whole.unpaired).toEqual({ baseGops: 0, highGops: 0, highKeys: 0 });

    // A frame just before a keyframe does not stand in for it.
    const base = asBase(lo), frames = base.frames!;
    frames.t = frames.t.map((t, j) => (j === 10 * FPS - 1 ? 10 - 0.01 : t));
    // The picture of high GOP 2 is missing, and one picture matches no GOP.
    const keys = hi.keys(), size = W * H, keep = keys.t.map((_, k) => k).filter((k) => k !== 2);
    const px = new Uint8Array((keep.length + 1) * size);
    keep.forEach((k, r) => px.set(keys.px.subarray(k * size, (k + 1) * size), r * size));
    const stray = { w: W, h: H, t: [...keep.map((k) => keys.t[k]), hi.end - 0.5], px };
    const { trace } = placeStretch(WINDOW, { ...base, frames }, { ...asHigh(hi, HIGH_LIST), keys: stray });
    expect(trace.baseFrames[10]).toBe(10 * FPS);
    expect(trace.high!.keys.slice(0, 4)).toEqual([0, 1, null, 2]);
    expect(trace.high!.matched[2]).toBeNull();
    expect(trace.unpaired).toEqual({ baseGops: 0, highGops: 1, highKeys: 1 });

    // Without base pictures there is nothing to pair the base with.
    const blind = placeStretch(WINDOW, asBase(lo, { pictures: false })).trace;
    expect(blind.baseFrames.every((j) => j == null)).toBe(true);
    expect(blind.unpaired.baseGops).toBe(0);
  });
});
