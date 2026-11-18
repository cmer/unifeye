import { describe, expect, it } from "vitest";
import { entryFor, skipLead, startAfter, wallAt, type Entry, type Seams } from "@/server/media/timeline";

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

describe("where a stretch starts after the one before", () => {
  const E = (kind: Entry["kind"], lead = false): Entry => ({ kind, base: 0, len: 1, at: ws, span: 1000, ...(kind !== "base" ? { high: 0 } : {}), ...(lead ? { lead: true as const } : {}) });
  const S = (base: [string, string], high?: [string, string]): Seams => ({ base: { first: base[0], last: base[1] }, high: high ? { first: high[0], last: high[1] } : null });
  // An adaptive stretch: the high lead, the base lead, then the stretch itself.
  const adaptive = [E("insert", true), E("base", true), E("over"), E("base")];
  // A plain stretch: its lead, then the stretch.
  const plain = [E("base", true), E("base")];
  const cases: [string, Seams | null, Seams, Entry[], number][] = [
    ["nothing before: the base lead plays, the high lead never does", null, S(["k1", "k9"], ["h1", "h9"]), adaptive, 1],
    ["the base ended on the same keyframe: past both leads", S(["k0", "k1"]), S(["k1", "k9"], ["h1", "h9"]), adaptive, 2],
    ["a different keyframe: the base lead plays so nothing is left out", S(["k0", "k2"], ["h0", "h1"]), S(["k1", "k9"], ["h1", "h9"]), adaptive, 1],
    ["no keyframes known: the base lead plays", S(["", ""]), S(["", ""], ["h1", "h9"]), adaptive, 1],
    ["a plain stretch after the same keyframe", S(["k0", "k1"]), S(["k1", "k9"]), plain, 1],
    ["a plain stretch after a different keyframe", S(["k0", "k2"]), S(["k1", "k9"]), plain, 0],
    ["a plain high-resolution stretch after an adaptive one that ended on its lead", S(["k0", "k2"], ["h0", "h1"]), S(["h1", "h9"]), plain, 1],
    ["a plain stretch first", null, S(["k1", "k9"]), plain, 0],
    ["a stretch without a base lead: past the high one", S(["k0", "k2"]), S(["k1", "k9"], ["h1", "h9"]), [E("insert", true), E("base")], 1],
    ["a stretch without leads", S(["k0", "k1"]), S(["k1", "k9"]), [E("base")], 0],
  ];
  it.each(cases)("%s", (_, prev, seams, entries, at) => {
    expect(startAfter(prev, { seams, entries })).toBe(at);
  });
});
