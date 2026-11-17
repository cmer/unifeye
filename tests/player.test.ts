import { describe, expect, it } from "vitest";
import { canHandOver, clipStartOf, offsetFor, overlayStartFor, overlayTimeAt, shouldArm, stepFrame, windowStart, type MediaPort } from "@/ui/recorded-playback";
import { dragTrim, MIN_CLIP, nearestEnd, panTrim, startTrim, TRIM_SPAN, typeTrim, viewFor, zoomTrim, type Trim } from "@/ui/trim";

/** A <video> element as far as playback can see one. Seeking is instant unless `seeks` is set. */
function el(over: Partial<MediaPort> & { seeks?: boolean } = {}) {
  const calls: string[] = [];
  const e = {
    currentTime: 0, playbackRate: 1, readyState: 4, paused: false, seeking: false, error: null as unknown,
    async play() { calls.push("play"); e.paused = false; },
    pause() { calls.push("pause"); e.paused = true; },
    calls,
    ...over,
  };
  return e;
}

const W = 60_000, ws = 1_800_000_000_000;

describe("recorded playback", () => {
  it("places media time 0 at the lead, or at the first recorded moment in the window", () => {
    expect(windowStart(ws + 59_999, W)).toBe(ws);
    expect(clipStartOf(ws, W, 2500, null)).toBe(ws - 2500);
    expect(clipStartOf(ws, W, 0, { ranges: [[ws + 20_000, ws + 90_000]], precision: "exact" })).toBe(ws + 20_000);
    expect(clipStartOf(ws, W, 0, { ranges: [[ws - 5000, ws + 90_000]], precision: "exact" })).toBe(ws);
    expect(clipStartOf(ws, W, 0, { ranges: [[ws + 20_000, ws + 90_000]], precision: "bounds" })).toBe(ws);
    expect(offsetFor(ws + 10_000, ws - 2500)).toBe(12.5);
    expect(offsetFor(ws, ws + 20_000)).toBe(0);
  });

  it("buffers the next window only once it is fully recorded, and hands over only to a healthy one", () => {
    expect(shouldArm(ws, W, ws + 2 * W + 2001)).toBe(true);
    expect(shouldArm(ws, W, ws + 2 * W + 2000)).toBe(false);
    expect(canHandOver(el(), ws + W, ws + W + 5001)).toBe(true);
    expect(canHandOver(el(), ws + W, ws + W + 4000)).toBe(false); // too close to live: seek instead
    expect(canHandOver(el({ error: new Error("decode") }), ws + W, ws + W + 9000)).toBe(false);
    expect(canHandOver(null, ws + W, ws + W + 9000)).toBe(false);
  });

  it("hands over at the window's end, not when the file (which runs on by the next lead) ends", () => {
    const clipStart = ws - 2000, w = { overlay: [], clipStart, windowEnd: ws + W };
    expect(stepFrame(el({ currentTime: 61.9 }), null, w).handOver).toBe(false);
    expect(stepFrame(el({ currentTime: 62 }), null, w).handOver).toBe(true);
    // Not while paused, seeking or without a frame.
    for (const o of [{ paused: true }, { seeking: true }, { readyState: 1 }]) expect(stepFrame(el({ currentTime: 63, ...o }), null, w).handOver).toBe(false);
  });

  const overlay = [{ at: 14, from: 0, len: 9 }, { at: 44, from: 9, len: 9 }];
  const w = { overlay, clipStart: ws - 2000, windowEnd: ws + W };

  it("maps base time to overlay time inside a stretch only", () => {
    expect(overlayTimeAt(overlay, 13.9)).toBeNull();
    expect(overlayTimeAt(overlay, 14)).toBe(0);
    expect(overlayTimeAt(overlay, 50)).toBe(15);
    expect(overlayTimeAt(overlay, 53)).toBeNull();
  });

  it("shows the overlay inside a stretch once it has the right frame, moving it when it drifts", () => {
    const base = el({ currentTime: 20, playbackRate: 2 }), high = el({ currentTime: 0, paused: true });
    const r = stepFrame(base, high, w);
    expect(high.currentTime).toBe(6); expect(high.playbackRate).toBe(2); expect(high.calls).toEqual(["play"]);
    expect(r.showHigh).toBe(true);
    // Within a quarter second it is left alone.
    high.currentTime = 6.2;
    expect(stepFrame(base, high, w).showHigh).toBe(true); expect(high.currentTime).toBe(6.2);
    // Still seeking or without a frame: the base shows through.
    expect(stepFrame(base, Object.assign(el({ currentTime: 6 }), { seeking: true }), w).showHigh).toBe(false);
    expect(stepFrame(base, el({ currentTime: 6, readyState: 1 }), w).showHigh).toBe(false);
  });

  it("pauses the overlay with the base", () => {
    const high = el({ currentTime: 6 });
    stepFrame(el({ currentTime: 20, paused: true }), high, w);
    expect(high.paused).toBe(true);
  });

  it("parks the overlay at the next stretch between stretches, hidden", () => {
    const high = el({ currentTime: 3 });
    const r = stepFrame(el({ currentTime: 30 }), high, w);
    expect(r.showHigh).toBe(false); expect(high.paused).toBe(true); expect(high.currentTime).toBe(9);
    // After the last stretch it stays where it is.
    const after = el({ currentTime: 15 });
    stepFrame(el({ currentTime: 55 }), after, w);
    expect(after.currentTime).toBe(15);
  });

  it("never shows a broken overlay", () => {
    expect(stepFrame(el({ currentTime: 20 }), el({ currentTime: 6, error: new Error("network") }), w).showHigh).toBe(false);
  });

  it("buffers the next window's overlay where its base will start", () => {
    expect(overlayStartFor({ startMs: ws, endMs: ws + W, leadMs: 2000, overlay })).toBe(0);
    expect(overlayStartFor({ startMs: ws, endMs: ws + W, leadMs: 16_000, overlay })).toBe(2);
    expect(overlayStartFor({ startMs: ws, endMs: ws + W, leadMs: 2000, overlay: [] })).toBe(0);
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
