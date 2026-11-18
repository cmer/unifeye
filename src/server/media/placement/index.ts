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
import { frameDiffs, matchGops, pairByTime, type MatchOptions, type Thumbs } from "./pictures";

export type { Thumbs } from "./pictures";

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
}

export const PLACEMENT: PlacementSettings = {
  thumb: { w: 64, h: 48 },
  match: { band: 0.07, motion: 1, threshold: 0.8, floor: 0.6, bonus: 0.3, slack: 0.6, margin: 0.05, apart: 2, tie: 0.05 },
  jumpRatio: 5,
  clock: { overflow: 20, emptySegment: 5, offJump: 1, gapSec: 8, anchorWeight: 2, anchorSlackSec: 3 },
  holes: { open: 1, close: 0.5, split: 0.2, weak: 0.5, scaleMs: 30_000 },
};

/** The window [startMs, endMs) the files were exported for, in wall-clock ms. */
export interface Window { startMs: number; endMs: number }

/**
 * The base file: its GOPs (`gopsOf`), its video's end in seconds, and the recorder's segment list
 * for its channel (null when the recorder gives none). `frames`, thumbnails of every frame at
 * `thumb` size, are needed to place a high file and let hidden time go where the picture jumps;
 * without them the base is placed by the segment list alone.
 */
export interface BaseFile { gops: Gop[]; end: number; segments: Segments | null; frames?: Thumbs }

/** The high-resolution file of an adaptive recording: as `BaseFile`, with thumbnails of its keyframes. */
export interface HighFile { gops: Gop[]; end: number; segments: Segments | null; keys: Thumbs }

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
