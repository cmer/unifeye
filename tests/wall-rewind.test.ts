import { describe, expect, it } from "vitest";
import { median, mergeRanges, outOfStep } from "@/ui/wall-rewind";

describe("rewinding the wall", () => {
  it("joins the cameras' recorded ranges into one timeline", () => {
    expect(mergeRanges([[[0, 10], [20, 30]], [[5, 12], [40, 50]], [[29, 35]]])).toEqual([[0, 12], [20, 35], [40, 50]]);
    expect(mergeRanges([])).toEqual([]);
  });

  it("follows the middle tile, so one slow or early tile doesn't pull the wall", () => {
    expect(median([5, 1, 100])).toBe(5);
    expect(median([1, 2, 3, 4])).toBe(2);
    expect(median([7])).toBe(7);
  });

  it("moves a tile back in step only when it is well off, and not again right away", () => {
    const times = new Map([["a", 10_000], ["b", 10_500], ["c", 20_000], ["d", 2_000]]);
    expect(outOfStep(times, 10_000, new Map(), 50_000)).toEqual(["c", "d"]);
    expect(outOfStep(times, 10_000, new Map([["c", 45_000]]), 50_000)).toEqual(["d"]);
    expect(outOfStep(times, 10_000, new Map([["c", 40_000]]), 50_000)).toEqual(["c", "d"]);
  });
});
