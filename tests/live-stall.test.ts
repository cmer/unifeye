import { describe, expect, it } from "vitest";
import { preferHlsJs, stallWatch } from "@/ui/live-stall";

/** Feeds `check` one sample a second: [position, running] pairs, returning every action taken. */
const run = (samples: [number, boolean?][], opts?: Parameters<typeof stallWatch>[0]) => {
  const check = stallWatch(opts);
  return samples.map(([t, running = true], i) => check(i * 1000, t, running));
};

describe("noticing live HLS that has stopped", () => {
  it("does nothing while playback moves", () => {
    expect(run([[0], [1], [2], [3], [4], [5]]).every((a) => a === null)).toBe(true);
  });

  it("jumps to live once playback has stood still long enough", () => {
    expect(run([[0], [1], [1], [1], [1], [1]])).toEqual([null, null, null, null, "jump", null]);
  });

  it("does not take the jump itself for playback moving, and reconnects if it stays stuck", () => {
    // Stuck at 1, jump at 4 s, the jump moves the position to 9, which then stands still.
    const acts = run([[0], [1], [1], [1], [1], [9], [9], [9], [9], [9], [9]]);
    expect(acts.indexOf("jump")).toBe(4);
    expect(acts.indexOf("reconnect")).toBe(9);
  });

  it("is satisfied once playback moves again after a jump", () => {
    const acts = run([[0], [1], [1], [1], [1], [9], [10], [11], [12], [13], [14], [15]]);
    expect(acts.filter(Boolean)).toEqual(["jump"]);
  });

  it("never counts time while not running (not started, paused or the tab hidden)", () => {
    const acts = run([[0, false], [0, false], [0, false], [0, false], [0, false], [0], [1], [2]]);
    expect(acts.every((a) => a === null)).toBe(true);
  });

  it("starts counting again after a reconnect", () => {
    const acts = run(Array.from({ length: 13 }, () => [5] as [number]));
    expect(acts.filter(Boolean)).toEqual(["jump", "reconnect", "jump"]);
  });
});

describe("choosing the HLS player", () => {
  it("uses hls.js in Chrome, Edge and Firefox, and the browser's own player in Safari", () => {
    expect(preferHlsJs("Google Inc.")).toBe(true);
    expect(preferHlsJs("")).toBe(true);
    expect(preferHlsJs("Apple Computer, Inc.")).toBe(false);
  });
});
