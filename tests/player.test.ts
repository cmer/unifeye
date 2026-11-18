import { describe, expect, it } from "vitest";
import type { Entry } from "@/server/media/timeline";
import { canHandOver, carryOnAt, cursorAt, cursorAtBase, handOver, positionAt, seekTo, shouldArm, stepEntries, stepPlayback, windowStart, type MediaPort } from "@/ui/recorded-playback";
import { DAY, fmtAgo, tickTimes, timelineBounds } from "@/ui/timeline";
import { dragTrim, MIN_CLIP, nearestEnd, panTrim, startTrim, TRIM_SPAN, typeTrim, viewFor, zoomTrim, type Trim } from "@/ui/trim";

/** A <video> element as far as playback can see one. Moving it is instant. */
function el(over: Partial<MediaPort> = {}) {
  const calls: string[] = [];
  const e = {
    currentTime: 0, playbackRate: 1, readyState: 4, paused: false, seeking: false, ended: false, error: null as unknown,
    async play() { calls.push("play"); e.paused = false; },
    pause() { calls.push("pause"); e.paused = true; },
    calls,
    ...over,
  };
  return e;
}

const W = 60_000, ws = 1_800_000_000_000;

/** An entry; wall-clock time runs at the speed of playback. */
const E = (kind: Entry["kind"], base: number, len: number, at: number, high?: number, lead = false): Entry =>
  ({ kind, base, len, at, span: len * 1000, ...(high != null ? { high } : {}), ...(lead ? { lead: true as const } : {}) });
/**
 * A window of an adaptive recording: the low file has a 10 s hole at ws+20 s, which the high file
 * fills; the high file covers ws+15 s to ws+35 s. Both start with a lead.
 */
const entries: Entry[] = [
  E("insert", 0, 1, ws - 300_000, 0, true),
  E("base", 0, 1, ws, undefined, true),
  E("base", 1, 14, ws + 1000),
  E("over", 15, 5, ws + 15_000, 1),
  E("insert", 20, 10, ws + 20_000, 6),
  E("over", 20, 5, ws + 30_000, 16),
  E("base", 25, 25, ws + 35_000),
];
const playing = { playing: true, rate: 1 };

describe("recorded playback", () => {
  it("buffers the next window only once it is fully recorded, and hands over only to a healthy one", () => {
    expect(windowStart(ws + 59_999, W)).toBe(ws);
    expect(shouldArm(ws, W, ws + 2 * W + 2001)).toBe(true);
    expect(shouldArm(ws, W, ws + 2 * W + 2000)).toBe(false);
    expect(canHandOver(el(), ws + W, ws + W + 5001)).toBe(true);
    expect(canHandOver(el(), ws + W, ws + W + 4000)).toBe(false); // too close to live: seek instead
    expect(canHandOver(el({ error: new Error("decode") }), ws + W, ws + W + 9000)).toBe(false);
    expect(canHandOver(null, ws + W, ws + W + 9000)).toBe(false);
  });

  it("seeks to the entry that shows a moment, with the high file waiting where it is next needed", () => {
    expect(cursorAt(entries, ws + 10_000)).toEqual({ i: 2, base: 10, high: 1 });
    expect(cursorAt(entries, ws + 17_000)).toEqual({ i: 3, base: 17, high: 3 });
    // A moment only the high file has: the base waits at the hole.
    expect(cursorAt(entries, ws + 25_000)).toEqual({ i: 4, base: 20, high: 11 });
    // Leads only before the window starts; a moment past the end ends the window.
    expect(cursorAt(entries, ws)).toEqual({ i: 1, base: 0, high: 1 });
    expect(cursorAt(entries, ws + 90_000)).toEqual({ i: 6, base: 50 });
  });

  it("plays on from the window before past its leads only when it ended with the same keyframe", () => {
    const next = { entries, seams: { base: { first: "k1", last: "k9" }, high: { first: "h1", last: "h9" } } };
    expect(carryOnAt({ seams: { base: { first: "k0", last: "k1" }, high: null } }, next)).toBe(2);
    // Otherwise the base lead plays too, so nothing is left out; the high lead never does.
    expect(carryOnAt({ seams: { base: { first: "k0", last: "k2" }, high: null } }, next)).toBe(1);
    expect(carryOnAt({ seams: { base: { first: "", last: "" }, high: null } }, { ...next, seams: { ...next.seams, base: { first: "", last: "" } } })).toBe(1);
    // The next window's files wait there while this one plays.
    expect(positionAt(entries, 2)).toEqual({ base: 1, high: 1 });
  });

  it("carries on from where the base is when the high file's order arrives", () => {
    expect(cursorAtBase(entries, 10)).toEqual({ i: 2, high: 1 });
    expect(cursorAtBase(entries, 22)).toEqual({ i: 5, high: 18 });
    // At the hole: the insert there has not been shown yet.
    expect(cursorAtBase(entries, 20)).toEqual({ i: 4, high: 6 });
    expect(cursorAtBase(entries, 50)).toEqual({ i: 7 });
  });

  it("plays the base alone with the high file paused and waiting, hidden", () => {
    const base = el({ currentTime: 10 }), high = el({ currentTime: 0, paused: true });
    const r = stepEntries(base, high, entries, { i: 2 }, playing);
    expect(r).toEqual({ cur: { i: 2 }, handOver: false, showHigh: false, wall: ws + 10_000 });
    expect(high).toMatchObject({ currentTime: 1, paused: true });
    expect(base.calls).toEqual([]);
  });

  it("shows the high file over the base once it has caught up, moving it when it drifts", () => {
    const base = el({ currentTime: 15.01, playbackRate: 2 }), high = el({ currentTime: 1, paused: true });
    const r = stepEntries(base, high, entries, { i: 2 }, { playing: true, rate: 2 });
    expect(r).toMatchObject({ cur: { i: 3 }, showHigh: true, wall: ws + 15_010 });
    expect(high).toMatchObject({ currentTime: 1, paused: false, playbackRate: 2 });
    // Within a quarter second it is left alone; further off it is moved.
    base.currentTime = 17; high.currentTime = 3.2;
    expect(stepEntries(base, high, entries, { i: 3 }, playing).showHigh).toBe(true);
    expect(high.currentTime).toBe(3.2);
    high.currentTime = 4;
    stepEntries(base, high, entries, { i: 3 }, playing);
    expect(high.currentTime).toBe(3);
    // Still moving or without a frame: the base shows through.
    expect(stepEntries(base, el({ currentTime: 3, seeking: true }), entries, { i: 3 }, playing).showHigh).toBe(false);
    expect(stepEntries(base, el({ currentTime: 3, readyState: 1 }), entries, { i: 3 }, playing).showHigh).toBe(false);
  });

  it("plays a moment only the high file has with the base waiting, then the base takes over again", () => {
    const base = el({ currentTime: 20 }), high = el({ currentTime: 6 });
    let r = stepEntries(base, high, entries, { i: 3 }, playing);
    expect(r).toMatchObject({ cur: { i: 4 }, showHigh: true, wall: ws + 20_000 });
    expect(base.paused).toBe(true);
    expect(high.paused).toBe(false);
    high.currentTime = 11;
    expect(stepEntries(base, high, entries, { i: 4 }, playing).wall).toBe(ws + 25_000);
    // The high file runs straight on into the next over; the base starts again from where it waited.
    high.currentTime = 16;
    r = stepEntries(base, high, entries, { i: 4 }, playing);
    expect(r).toMatchObject({ cur: { i: 5 }, showHigh: true, wall: ws + 30_000 });
    expect(base.calls).toEqual(["pause", "play"]);
    expect(base.currentTime).toBe(20);
  });

  it("waits for the high file during an insert, rather than skipping it", () => {
    const base = el({ currentTime: 20.01 }), high = el({ readyState: 0 });
    const r = stepEntries(base, high, entries, { i: 4 }, playing);
    expect(r).toEqual({ cur: { i: 4 }, handOver: false, showHigh: false, wall: null });
    expect(base.paused).toBe(true);
  });

  it("skips what only a missing or broken high file has, and plays overs as the base", () => {
    for (const high of [null, el({ currentTime: 6, error: new Error("network") })]) {
      const base = el({ currentTime: 20 });
      const r = stepEntries(base, high, entries, { i: 3 }, playing);
      expect(r).toMatchObject({ cur: { i: 5 }, showHigh: false, wall: ws + 30_000 });
      expect(base.paused).toBe(false);
    }
  });

  it("moves each file where a seek asked once it can be moved, and only then plays on", () => {
    const base = el({ readyState: 0 }), high = el({ readyState: 0 });
    let r = stepEntries(base, high, entries, { i: 4, base: 20, high: 11 }, playing);
    expect(r).toMatchObject({ cur: { i: 4, base: 20, high: 11 }, wall: null });
    Object.assign(base, { readyState: 1 });
    r = stepEntries(base, high, entries, r.cur, playing);
    expect(base.currentTime).toBe(20);
    expect(r.cur).toEqual({ i: 4, high: 11 });
    Object.assign(high, { readyState: 4 });
    r = stepEntries(base, high, entries, r.cur, playing);
    expect(high.currentTime).toBe(11);
    expect(r).toMatchObject({ cur: { i: 4 }, showHigh: true, wall: ws + 25_000 });
  });

  it("hands over at the end of the entries while playing, not while paused", () => {
    const at = { i: 6 };
    expect(stepEntries(el({ currentTime: 50, ended: true, paused: true }), el({ paused: true }), entries, at, playing)).toMatchObject({ cur: { i: 7 }, handOver: true });
    expect(stepEntries(el({ currentTime: 50, ended: true, paused: true }), el({ paused: true }), entries, at, { playing: false, rate: 1 }).handOver).toBe(false);
    // The base file running on past its last entry is held there.
    const base = el({ currentTime: 50.2 });
    expect(stepEntries(base, null, entries, at, playing).handOver).toBe(true);
    expect(base.paused).toBe(true);
  });

  it("pauses both files when playback is paused", () => {
    const base = el({ currentTime: 17 }), high = el({ currentTime: 3 });
    const r = stepEntries(base, high, entries, { i: 3 }, { playing: false, rate: 1 });
    expect(base.paused && high.paused).toBe(true);
    expect(r).toMatchObject({ cur: { i: 3 }, showHigh: true, wall: ws + 17_000 });
  });
});

describe("recorded playback across frames", () => {
  const A = { key: `${ws}:1`, info: { entries, seams: { base: { first: "k0", last: "k9" }, high: { first: "h0", last: "h9" } } } };
  /** The base file alone for the same window, while the high file is placed. */
  const early = { key: A.key, info: { entries: [E("base", 0, 1, ws, undefined, true), E("base", 1, 49, ws + 1000)], pending: true as const } };
  /**
   * The window after A, whose base lead (the keyframe A ended with) starts half a second before the
   * window and runs a second, as the recorder's do: the window's first moment is inside it.
   */
  const ws2 = ws + W, B = {
    key: `${ws2}:1`,
    info: { entries: [E("base", 0, 1, ws2 - 500, undefined, true), E("base", 1, 59, ws2 + 500)], seams: { base: { first: "k9", last: "k20" }, high: null } },
  };
  const at = (target: number, shown = target) => ({ target, shown });

  it("starts a window with a seek to the moment asked for", () => {
    const r = stepPlayback(null, A, el({ currentTime: 0 }), el({ paused: true }), at(ws + 25_000), playing)!;
    expect(r.s).toMatchObject({ key: A.key, seek: true, pending: false, cur: { i: 4 } });
    expect(r.step).toMatchObject({ showHigh: true, wall: ws + 25_000 });
    // A seek elsewhere (a new key) starts again, whatever was playing.
    expect(stepPlayback(r.s, { ...A, key: `${ws}:2` }, el(), el(), at(ws + 10_000), playing)!.s).toMatchObject({ key: `${ws}:2`, seek: true, cur: { i: 2 } });
  });

  it("starts again from the moment asked for when the high file's order arrives within 10 seconds of a seek", () => {
    const base = el({ currentTime: 0 });
    let r = stepPlayback(null, early, base, null, at(ws + 25_000), playing)!;
    expect(r.s).toMatchObject({ pending: true, cur: { i: 1 } });
    expect(base.currentTime).toBe(25);
    base.currentTime = 30; // the base played on alone for five seconds
    r = stepPlayback(r.s, A, base, el(), at(ws + 25_000, ws + 30_000), playing)!;
    expect(r.s).toMatchObject({ pending: false, cur: { i: 4 } }); // the moment only the high file has
    expect(r.step.showHigh).toBe(true);
    expect(base.paused).toBe(true);
  });

  it("carries on from the base when the order arrives 10 seconds or more after the seek, or after a hand-over", () => {
    const base = el({ currentTime: 0 });
    let r = stepPlayback(null, early, base, null, at(ws + 25_000), playing)!;
    base.currentTime = 35;
    r = stepPlayback(r.s, A, base, el({ currentTime: 0, paused: true }), at(ws + 25_000, ws + 35_000), playing)!;
    expect(r.s).toMatchObject({ pending: false, cur: { i: 6 } });
    expect(base.currentTime).toBe(35);
    expect(r.step.wall).toBe(ws + 45_000); // the base file skips the 10 s the high file fills
    // Not started by a seek: always from the base, however close to the window's first moment.
    const handed = { ...seekTo(early, ws), seek: false, cur: { i: 1 } };
    base.currentTime = 22;
    const high = el({ currentTime: 0 });
    expect(stepPlayback(handed, A, base, high, at(ws, ws + 1000), playing)!.s.cur).toEqual({ i: 5 });
    expect(high.currentTime).toBe(18);
    // A seek not yet carried out restarts from the moment asked for, however long ago that was.
    const unmoved = { ...seekTo(early, ws + 25_000), cur: { i: 1, base: 25 } };
    expect(stepPlayback(unmoved, A, el({ currentTime: 0 }), el(), at(ws + 25_000, ws + 50_000), playing)!.s.cur.i).toBe(4);
  });

  it("hands over to the next window where the window before left off, past the keyframe it ended with", () => {
    const s = handOver(A, B);
    expect(s).toMatchObject({ key: B.key, seek: false, pending: false, from: A.key, cur: { i: 1, base: 1 } });
    // A seek to the window's first moment would land half a second into the lead, a moment shown already.
    expect(cursorAt(B.info.entries, ws2)).toEqual({ i: 0, base: 0.5 });
    const base = el({ currentTime: 1 });
    const r = stepPlayback(s, B, base, null, at(ws2), playing)!;
    expect(r.s).toMatchObject({ key: B.key, seek: false, cur: { i: 1 } });
    expect(base.currentTime).toBe(1);
    expect(r.step.wall).toBe(ws2 + 500);
  });

  it("ignores a frame of the window handed over from that runs before the player has caught up", () => {
    const s = handOver(A, B), old = el({ currentTime: 50, ended: true, paused: true });
    // Before, such a frame took the hand-over for a seek and restarted the next window at its first
    // moment, inside the lead, so the last moments of the window before played twice.
    expect(stepPlayback(s, A, old, null, at(ws + 10_000), playing)).toBeNull();
    expect(old.calls).toEqual([]);
    const base = el({ currentTime: 1 });
    expect(stepPlayback(s, B, base, null, at(ws2), playing)!.s.cur).toEqual({ i: 1 });
    expect(base.currentTime).toBe(1);
  });
});

describe("choosing a clip", () => {
  const now = ws + 3600_000, maxClip = 3600_000, lim = { now, maxClip };
  const sel = (a: number, b: number, extra: Partial<Trim> = {}): Trim => ({ a, b, view: viewFor(a, b), grab: null, zoomed: false, ...extra });

  it("starts with 30 seconds ending a little after the playhead, or just behind live", () => {
    expect(startTrim(ws, false, lim)).toMatchObject({ a: ws - 15_000, b: ws + 15_000, zoomed: false });
    expect(startTrim(ws, true, lim)).toMatchObject({ a: now - 32_000, b: now - 2000 });
    expect(startTrim(now - 5000, false, lim).b).toBe(now - 2000);
    expect(startTrim(ws, false, { now, maxClip: 10_000 })).toMatchObject({ a: ws + 5000, b: ws + 15_000 });
  });

  it("drags one end within the limits, refitting the view only when the drag ends", () => {
    const tr = sel(ws, ws + 30_000);
    expect(dragTrim(tr, "a", ws + 29_000, false, lim)).toMatchObject({ a: ws + 30_000 - MIN_CLIP, b: ws + 30_000, grab: "a", view: tr.view });
    expect(dragTrim(tr, "a", ws - 2 * maxClip, false, lim).a).toBe(ws + 30_000 - maxClip);
    expect(dragTrim(tr, "b", now + 60_000, false, lim).b).toBe(now - 2000);
    expect(dragTrim(tr, "b", now, false, { now, maxClip: 600_000 }).b).toBe(ws + 600_000);
    const done = dragTrim(tr, "b", ws + 120_000, true, lim);
    expect(done).toMatchObject({ b: ws + 120_000, grab: null, view: viewFor(ws, ws + 120_000) });
  });

  it("sets a typed end exactly and moves the other only as far as needed", () => {
    const tr = sel(ws, ws + 30_000);
    expect(typeTrim(tr, "a", ws + 10_000, lim)).toMatchObject({ a: ws + 10_000, b: ws + 30_000 });
    expect(typeTrim(tr, "a", ws + 40_000, lim)).toMatchObject({ a: ws + 40_000, b: ws + 40_000 + MIN_CLIP });
    expect(typeTrim(tr, "b", ws - 10_000, lim)).toMatchObject({ a: ws - 10_000 - MIN_CLIP, b: ws - 10_000 });
    expect(typeTrim(tr, "b", now + 1000, lim).b).toBe(now - 2000);
    expect(typeTrim(tr, "a", ws - 2 * maxClip, lim)).toMatchObject({ a: ws - 2 * maxClip, b: ws - 2 * maxClip + maxClip });
  });

  it("keeps a zoomed view put while the selection stays inside it, and slides it when it leaves", () => {
    const tr = sel(ws, ws + 30_000, { view: [ws - 60_000, ws + 60_000], zoomed: true });
    expect(typeTrim(tr, "b", ws + 50_000, lim).view).toEqual([ws - 60_000, ws + 60_000]);
    expect(typeTrim(tr, "b", ws + 100_000, lim).view).toEqual([ws + 100_000 + 12_000 - 120_000, ws + 100_000 + 12_000]);
    // Too long to fit: refit around it.
    expect(typeTrim(tr, "b", ws + 600_000, lim).view).toEqual(viewFor(ws, ws + 600_000));
  });

  it("zooms around a point within its limits, never far past now", () => {
    const tr = sel(ws, ws + 30_000, { view: [ws, ws + 600_000] });
    expect(zoomTrim(tr, 0.5, 0, now)).toMatchObject({ view: [ws, ws + 300_000], zoomed: true });
    expect(zoomTrim(tr, 0.5, undefined, now).view).toEqual([ws + 15_000 - 150_000, ws + 15_000 + 150_000]);
    const close = sel(ws, ws + 30_000, { view: [ws, ws + TRIM_SPAN[0]] });
    expect(zoomTrim(close, 0.5, 0, now)).toBe(close);
    const recent = sel(now - 60_000, now - 30_000, { view: [now - 300_000, now] });
    expect(zoomTrim(recent, 2, 0, now).view[1]).toBe(now + 60_000); // around its left edge it would reach 5 minutes past now
  });

  it("pans sideways, stopping a little past now", () => {
    const tr = sel(ws, ws + 30_000, { view: [ws, ws + 600_000] });
    expect(panTrim(tr, 0.5, now)).toMatchObject({ view: [ws + 300_000, ws + 900_000], zoomed: true });
    expect(panTrim(tr, 100, now).view[1]).toBe(now + 60_000);
  });

  it("grabs the nearer end", () => {
    const tr = sel(ws, ws + 30_000);
    expect(nearestEnd(tr, ws + 10_000)).toBe("a");
    expect(nearestEnd(tr, ws + 20_000)).toBe("b");
  });
});

describe("timeline range", () => {
  const H = 3600_000, midnight = Date.UTC(2026, 10, 17), clock = midnight + 9.5 * H;

  it("shows the last 24 hours ending now, so live sits at the right edge", () => {
    expect(timelineBounds(clock, clock, false, "UTC")).toEqual({ rolling: true, lo: clock - DAY, hi: clock });
    expect(timelineBounds(clock - 20 * H, clock, false, "UTC").rolling).toBe(true);
  });

  it("shows a calendar day for older moments, or for a picked past date until playback reaches today", () => {
    expect(timelineBounds(clock - 36 * H, clock, false, "UTC")).toEqual({ rolling: false, lo: midnight - 2 * DAY, hi: midnight - DAY });
    expect(timelineBounds(clock - 12 * H, clock, true, "UTC")).toEqual({ rolling: false, lo: midnight - DAY, hi: midnight });
    expect(timelineBounds(midnight + H, clock, true, "UTC").rolling).toBe(true);
  });

  it("lines labels up on midnight in the chosen time zone", () => {
    expect(tickTimes(clock - DAY, clock, 6 * H, "UTC")).toEqual([midnight - 12 * H, midnight - 6 * H, midnight, midnight + 6 * H]);
    const toronto = tickTimes(clock - DAY, clock, 6 * H, "America/Toronto");
    expect(toronto.every((m) => (m - 5 * H) % (6 * H) === 0)).toBe(true);
  });

  it("says how far behind live a moment is", () => {
    expect(fmtAgo(8_000)).toBe("8 sec ago");
    expect(fmtAgo(12 * 60_000)).toBe("12 min ago");
    expect(fmtAgo(5 * H)).toBe("5 hr ago");
    expect(fmtAgo(5 * H + 12 * 60_000)).toBe("5 hr 12 min ago");
    expect(fmtAgo(3 * DAY)).toBeNull();
  });
});
