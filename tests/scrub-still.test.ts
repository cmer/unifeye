import { describe, expect, it } from "vitest";
import { StillFeed, WindowWarmer } from "@/ui/scrub-still";

/** A feed on a hand-driven clock, with loads answered by the test. */
function rig() {
  let clock = 1000;
  const timers: { at: number; fn: () => void }[] = [];
  const loads: { ms: number; ok: (url: string) => void; no: () => void }[] = [];
  const shown: number[] = [], results: [boolean, number][] = [];
  const feed = new StillFeed(
    (ms) => new Promise((ok, no) => loads.push({ ms, ok, no: () => no(new Error("no image")) })),
    (_url, ms) => shown.push(ms),
    {
      gap: 250, now: () => clock,
      later: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return () => timers.splice(timers.indexOf(t), 1); },
      onResult: (ok, ms) => results.push([ok, ms]),
    },
  );
  const advance = async (ms: number) => {
    clock += ms;
    for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await Promise.resolve();
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { feed, loads, shown, results, timers, advance, settle };
}

describe("stills while dragging the timeline", () => {
  it("asks for one still at a time, and only for the latest moment wanted", async () => {
    const r = rig();
    r.feed.want(10_000);
    r.feed.want(20_000);
    r.feed.want(30_000);
    expect(r.loads.map((l) => l.ms)).toEqual([10_000]);
    await r.advance(300);
    r.loads[0].ok("a");
    await r.settle();
    expect(r.shown).toEqual([10_000]);
    expect(r.loads.map((l) => l.ms)).toEqual([10_000, 30_000]);
  });

  it("waits out the gap after a fast answer before asking again", async () => {
    const r = rig();
    r.feed.want(10_000);
    r.loads[0].ok("a");
    await r.settle();
    r.feed.want(20_000);
    expect(r.loads).toHaveLength(1);
    await r.advance(249);
    expect(r.loads).toHaveLength(1);
    await r.advance(1);
    expect(r.loads.map((l) => l.ms)).toEqual([10_000, 20_000]);
  });

  it("skips moments too close to the last one asked for", async () => {
    const r = rig();
    r.feed.want(10_000, 5000);
    r.loads[0].ok("a");
    await r.settle();
    await r.advance(1000);
    r.feed.want(14_000, 5000);
    expect(r.loads).toHaveLength(1);
    r.feed.want(16_000, 5000);
    expect(r.loads.map((l) => l.ms)).toEqual([10_000, 16_000]);
  });

  it("keeps the last still when one fails, and reports the miss with its moment", async () => {
    const r = rig();
    r.feed.want(10_000);
    r.loads[0].ok("a");
    await r.settle();
    await r.advance(300);
    r.feed.want(20_000);
    r.loads[1].no();
    await r.settle();
    expect(r.shown).toEqual([10_000]);
    expect(r.results).toEqual([[true, 10_000], [false, 20_000]]);
    // The same moment isn't asked for again.
    await r.advance(300);
    r.feed.want(20_000);
    expect(r.loads).toHaveLength(2);
  });

  it("shows nothing and asks for nothing once stopped", async () => {
    const r = rig();
    r.feed.want(10_000);
    r.feed.stop();
    r.loads[0].ok("a");
    await r.settle();
    r.feed.want(20_000);
    await r.advance(1000);
    expect(r.shown).toEqual([]);
    expect(r.results).toEqual([]);
    expect(r.loads).toHaveLength(1);
  });
});

describe("getting a stretch ready while dragging", () => {
  function warmRig() {
    let clock = 0;
    const timers: { at: number; fn: () => void }[] = [];
    const loads: { at: number; signal: AbortSignal }[] = [];
    const w = new WindowWarmer((at, signal) => { loads.push({ at, signal }); return new Promise(() => {}); }, {
      rest: 500, keep: 3000,
      later: (fn, ms) => { const t = { at: clock + ms, fn }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    });
    const advance = (ms: number) => { clock += ms; for (const t of timers.filter((x) => x.at <= clock)) { timers.splice(timers.indexOf(t), 1); t.fn(); } };
    return { w, loads, advance };
  }

  it("starts loading only once the playhead rests on one stretch", () => {
    const r = warmRig();
    r.w.at(60_000);
    r.advance(300);
    r.w.at(120_000);
    r.advance(300);
    expect(r.loads).toEqual([]);
    r.w.at(120_000);
    r.advance(200);
    expect(r.loads.map((l) => l.at)).toEqual([120_000]);
    r.w.at(120_000);
    r.advance(1000);
    expect(r.loads).toHaveLength(1);
  });

  it("cancels the load when the playhead moves to another stretch, or to a gap", () => {
    const r = warmRig();
    r.w.at(60_000);
    r.advance(500);
    r.w.at(120_000);
    expect(r.loads[0].signal.aborted).toBe(true);
    r.advance(500);
    expect(r.loads.map((l) => l.at)).toEqual([60_000, 120_000]);
    r.w.at(null);
    expect(r.loads[1].signal.aborted).toBe(true);
    r.advance(1000);
    expect(r.loads).toHaveLength(2);
  });

  it("keeps a load going briefly after letting go, so the seek can join it", () => {
    const r = warmRig();
    r.w.at(60_000);
    r.advance(500);
    r.w.release();
    r.advance(2999);
    expect(r.loads[0].signal.aborted).toBe(false);
    r.advance(1);
    expect(r.loads[0].signal.aborted).toBe(true);
  });

  it("starts nothing when let go before resting, and cancels at once when stopped", () => {
    const r = warmRig();
    r.w.at(60_000);
    r.w.release();
    r.advance(1000);
    expect(r.loads).toEqual([]);
    r.w.at(60_000);
    r.advance(500);
    r.w.stop();
    expect(r.loads[0].signal.aborted).toBe(true);
  });

  it("never loads anything when turned off", () => {
    const w = new WindowWarmer(() => { throw new Error("should not load"); }, { rest: 0, later: () => () => {} });
    w.at(60_000);
    w.release();
  });
});
