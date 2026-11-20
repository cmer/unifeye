/**
 * Places one stretch of recorded video in time: the order to play its exports in, with the wall-clock
 * time of every moment. This is the whole interface of the placement module; `pictures.ts`,
 * `clock.ts` and `order.ts` are its implementation and nothing else imports them.
 *
 * An export is a plain run of GOPs with no times inside, starting with the last keyframe at or before
 * the requested start (the lead). The base file (the only one, or with adaptive recording the low
 * channel) gets keyframe times by fitting its GOPs into the recorder's segment list, with time the
 * list hides put where the picture jumps. A high-resolution file (adaptive recording) is placed on the
 * base by picture: each GOP whose keyframe looks like a base frame is shown over it, and the rest are
 * inserted into holes of the base, chosen by the recorder's times for them and by how they look
 * beside each hole's edges. Placed GOPs also pin the high file's own times, since its segment list is
 * off by many seconds. No burned-in clock is read: cameras need not show one.
 *
 * Every frame of both files ends up in the order once, so nothing recorded is left out. Wrong
 * placements show a moment out of order or twice; `scripts/adaptive-eval` measures how often on real
 * footage, through this interface.
 */
import type { Entry, Gop, Segments } from "../timeline";
import { clockOf, jumpsOf, keyTimes, type ClockCosts } from "./clock";
import { buildEntries, type HoleWeights } from "./order";
import { frameDiffs, likeness, matchGops, pairByTime, type MatchOptions, type Thumbs } from "./pictures";
import { baseSpans, highTimes, mediaAt, orderByTime, usable, type LagSettings } from "./stamped";

export type { Thumbs } from "./pictures";
/** True when `stamps` can serve as the times of `gops`: one each, in order (within `backMs`, for the high channel). */
export { usable as stampsFit } from "./stamped";

/** Every setting of the placement, in one place so a tuning run can change any of them. */
export interface PlacementSettings {
  /** Thumbnail size callers should hand in: small enough to be quick, large enough to tell moments apart. */
  thumb: { w: number; h: number };
  /** Matching high keyframes to base frames (`MatchOptions` explains each). `slack` also decides when a GOP carries straight on in the order. */
  match: MatchOptions;
  /** A base keyframe is a picture jump (time is missing there) when it differs from the frame before by this many times the usual change between frames. */
  jumpRatio: number;
  /** Fitting GOPs into the recorder's segments. */
  clock: ClockCosts;
  /** Choosing the hole for each high GOP the base lacks. */
  holes: HoleWeights;
  /** With the recorder's stamp for every GOP: finding how late the high channel's stamps run (`LagSettings` explains each). */
  lag: LagSettings;
}

export const PLACEMENT: PlacementSettings = {
  thumb: { w: 64, h: 48 },
  match: { band: 0.07, motion: 1, threshold: 0.8, floor: 0.6, bonus: 0.3, slack: 0.6, margin: 0.05, apart: 2, tie: 0.05 },
  jumpRatio: 5,
  clock: { overflow: 20, emptySegment: 5, offJump: 1, gapSec: 8, anchorWeight: 2, anchorSlackSec: 3 },
  holes: { open: 1, close: 0.5, split: 0.2, weak: 0.5, scaleMs: 30_000 },
  lag: { minSec: -1, maxSec: 36, stepSec: 0.2, absent: 0.7, breakCost: 0.3, stallSec: 5, grow: 0.27, drift: 0.01, shrink: 0.01, resetFromSec: 27, pauseSec: 20, resetToSec: 3, reset: 0.1, join: 0.6, stepBackSec: 5 },
};

/**
 * How far past a stretch's end its high file should reach when stamps are used, in ms: the recorder
 * stamps high-resolution GOPs late, so a GOP recorded inside the stretch can be stamped after it.
 */
export const highReachMs = (settings: PlacementSettings = PLACEMENT) => settings.lag.maxSec * 1000;

/** The window [startMs, endMs) the files were exported for, in wall-clock ms. */
export interface Window { startMs: number; endMs: number }

/**
 * The base file: its GOPs (`gopsOf`), its video's end in seconds, and the recorder's segment list
 * for its channel (null when the recorder gives none). `frames`, thumbnails of every frame at
 * `thumb` size, are needed to place a high file and let hidden time go where the picture jumps;
 * without them the base is placed by the segment list alone. `stamps`, the recorder's wall-clock ms
 * for each GOP's keyframe, replace the segment list and the guessing: the times are then exact.
 */
export interface BaseFile { gops: Gop[]; end: number; segments: Segments | null; frames?: Thumbs; stamps?: number[]; context?: Context }

/**
 * A longer export of the base's channel, reaching `highReachMs` before and after the stretch, with
 * its stamps and thumbnails of every frame. With stamps, the high file's GOPs are compared with this
 * instead of the base itself, so that a GOP recorded just outside the stretch is recognised as such
 * (and left to the stretch it belongs to) rather than squeezed into this one. It is only looked at.
 */
export interface Context { gops: Gop[]; stamps: number[]; frames: Thumbs }

/**
 * The high-resolution file of an adaptive recording: as `BaseFile`, with thumbnails of its keyframes.
 * Its `stamps` run late by a varying amount, so they are used only when the base has stamps too, and
 * then the file may hold more than the window: GOPs recorded outside it are left out of the order.
 */
export interface HighFile { gops: Gop[]; end: number; segments: Segments | null; keys: Thumbs; stamps?: number[] }

/** What the placement found, for logs and for measuring it (the order itself does not need it). */
export interface Trace {
  /** Base keyframe media times where the picture jumps. Empty without base frames. */
  jumps: number[];
  /** Wall-clock ms of each base GOP's keyframe. */
  baseTimes: number[];
  /** The index in `base.frames` of each base GOP's keyframe, or null (all null without base frames). */
  baseFrames: (number | null)[];
  /**
   * GOPs whose keyframe has no picture (`baseGops`: none in `base.frames`; `highGops`: none in
   * `high.keys`), and high keyframe pictures that belong to no GOP. All 0 unless the files' GOPs and
   * pictures disagree; an unpaired GOP is placed without its picture.
   */
  unpaired: { baseGops: number; highGops: number; highKeys: number };
  high?: {
    /** Wall-clock ms of each high GOP's keyframe. */
    times: number[];
    /** The index in `high.keys` of each high GOP's keyframe, or null. */
    keys: (number | null)[];
    /** The base media time each high GOP's keyframe looks like, or null. The order never lays the lead (GOP 0) over the base, and drops a match that would play backwards. */
    matched: (number | null)[];
    /** How alike high GOP g's keyframe and the base frame at base media time s are: about 1 for the same picture. */
    similar: (g: number, s: number) => number;
    /** With stamps: how many seconds each high GOP's stamp ran late. */
    lag?: number[];
  };
}

export interface Placed { entries: Entry[]; trace: Trace }

/** The playback order for a stretch's base file and, with adaptive recording, its high file (see the module comment). */
export function placeStretch(window: Window, base: BaseFile, high?: HighFile, settings: PlacementSettings = PLACEMENT): Placed {
  const { startMs, endMs } = window;
  // Each GOP's keyframe picture, paired once here; everything after works by index.
  const baseFrames = base.frames ? pairByTime(base.gops, base.frames.t) : base.gops.map(() => null);
  const keyOf = high ? pairByTime(high.gops, high.keys.t) : [];
  const nulls = (xs: (number | null)[]) => xs.filter((x) => x == null).length;
  const unpaired = {
    baseGops: base.frames ? nulls(baseFrames) : 0,
    highGops: nulls(keyOf),
    highKeys: high ? high.keys.t.length - new Set(keyOf.filter((k) => k != null)).size : 0,
  };
  if (usable(base.gops, base.stamps) && (!high || (usable(high.gops, high.stamps, settings.lag.stepBackSec * 1000) && base.frames))) {
    const spans = baseSpans(base.gops, base.stamps, settings.lag.join);
    const trace = { jumps: [], baseTimes: base.stamps, baseFrames, unpaired };
    if (!high || !base.frames) return { entries: orderByTime(startMs, endMs, spans), trace };
    const ctx = base.context && usable(base.context.gops, base.context.stamps) ? base.context : null;
    const frames = ctx ? ctx.frames : base.frames, seen = ctx ? baseSpans(ctx.gops, ctx.stamps, settings.lag.join) : spans;
    // The frame (of the context, or else the base) showing a wall-clock time: the last one at or before it.
    const frameAt = (ms: number) => {
      const s = mediaAt(seen, ms);
      if (s == null) return null;
      let a = 0, b = frames.t.length - 1;
      while (a < b) { const c = (a + b + 1) >> 1; if (frames.t[c] <= s + 1e-3) a = c; else b = c - 1; }
      return a;
    };
    const like = likeness(high.keys, frames, settings.match);
    const placed = highTimes(high.gops, high.stamps!, keyOf, frameAt, like, settings.lag);
    const matched = placed.times.map((t, g) => (placed.seen[g] ? mediaAt(spans, t) : null));
    // `similar` is asked in the base's media time; the pictures may be the context's.
    const wall = clockOf(base.gops, base.stamps);
    const similar = (g: number, s: number) => { const key = keyOf[g], f = key == null ? null : frameAt(wall(s)); return f == null ? 0 : like(key!, f); };
    return { entries: orderByTime(startMs, endMs, spans, { gops: high.gops, times: placed.times }), trace: { ...trace, high: { times: placed.times, keys: keyOf, matched, similar, lag: placed.lag } } };
  }
  const jumps = base.frames ? jumpsOf(frameDiffs(base.frames, settings.match.band), base.gops, baseFrames, settings.jumpRatio) : undefined;
  const baseTimes = keyTimes(startMs, endMs, base.gops, base.segments, { jumps }, settings.clock);
  const baseWall = clockOf(base.gops, baseTimes), order = { slack: settings.match.slack, holes: settings.holes };
  const b = { gops: base.gops, duration: base.end, wall: baseWall, jumps };
  const trace = { jumps: jumps ?? [], baseTimes, baseFrames, unpaired };
  if (!high) return { entries: buildEntries({ base: b }, order), trace };

  const { at, similar } = base.frames ? matchGops(high.keys, base.frames, high.gops, keyOf, settings.match) : { at: high.gops.map(() => null), similar: () => 0 };
  // A matched GOP's keyframe is at the base's time for that frame.
  const anchors = new Map<number, number>();
  at.forEach((a, g) => { if (a != null && g > 0) anchors.set(g, baseWall(a)); });
  const times = keyTimes(startMs, endMs, high.gops, high.segments, { anchors }, settings.clock);
  const entries = buildEntries({ base: b, high: { gops: high.gops, duration: high.end, wall: clockOf(high.gops, times), at, similar } }, order);
  return { entries, trace: { ...trace, high: { times, keys: keyOf, matched: at, similar } } };
}
