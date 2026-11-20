import { describe, expect, it } from "vitest";
import { warmTiles, warmWindows } from "@/ui/wall-warm";

describe("warmTiles", () => {
  const shown = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  it("picks tiles near the screen that are not playing, nearest first, at most four", () => {
    // d-f on screen; a-c above and g-j below are near.
    expect(warmTiles(shown, ["d", "e", "f"], shown)).toEqual(["c", "g", "b", "h"]);
  });
  it("leaves out tiles no longer shown, and takes the wall's order when none plays", () => {
    expect(warmTiles(["a", "b", "c"], [], ["c", "x", "a"])).toEqual(["a", "c"]);
  });
});

describe("warmWindows", () => {
  const W = 60_000, ws = 1_000 * W, now = ws + 10 * W;
  it("warms the wall's window, and the next one near its end", () => {
    expect(warmWindows(ws + 10_000, W, now)).toEqual([ws]);
    expect(warmWindows(ws + 45_000, W, now)).toEqual([ws, ws + W]);
  });
  it("skips windows not fully recorded yet", () => {
    expect(warmWindows(ws + 45_000, W, ws + 2 * W)).toEqual([ws]);
    expect(warmWindows(ws + 45_000, W, ws + W)).toEqual([]);
  });
});
