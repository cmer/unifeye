import { describe, expect, it } from "vitest";
import { entryFor, skipLead, wallAt, type Entry } from "@/server/media/timeline";

/**
 * Reading a stretch's playback order (`timeline.ts`), which the server and the player share. How the
 * order is built is in `tests/placement.test.ts`.
 */

const ws = 1_800_000_000_000;

describe("finding moments in a window's entries", () => {
  const E = (kind: Entry["kind"], base: number, len: number, at: number, lead = false): Entry => ({ kind, base, len, at, span: len * 1000, ...(lead ? { lead: true as const } : {}) });
  const es = [E("base", 0, 1, ws - 500, true), E("base", 1, 10, ws + 500), E("base", 11, 10, ws + 20_000)];

  it("finds the entry showing a moment, the next one in a gap, and the end past the last", () => {
    expect(entryFor(es, ws - 200)).toEqual({ i: 0, offset: 0.3 });
    expect(entryFor(es, ws + 5500)).toEqual({ i: 1, offset: 5 });
    expect(entryFor(es, ws + 15_000)).toEqual({ i: 2, offset: 0 });
    expect(entryFor(es, ws + 90_000)).toEqual({ i: 2, offset: 10 });
    expect(wallAt(es[1], 5)).toBe(ws + 5500);
    expect(skipLead(es)).toBe(1);
  });
});
