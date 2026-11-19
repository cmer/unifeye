import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MediaInfo } from "@/server/protect/ffmpeg";
import { NoRecordingError, RecorderBusyError } from "@/server/protect/types";
import { channelsFor, coveredMs, fetchRecorded, fetchRecordedFile, type Entry, type ExportChannel, type ListSegments, type ListStamps, type MediaOps, type Reach, type Recorded } from "@/server/media/recorded";
import { highReachMs, type Thumbs } from "@/server/media/placement";
import type { Gop, Seams } from "@/server/media/timeline";

/**
 * The adaptive-recording decisions, driven by a fake recorder and fake media operations: no FFmpeg.
 * Each channel is a list of recorded runs; its "export" is their GOPs back to back (1 s each), and its
 * thumbnails show a picture that depends only on the moment, so both channels show the same picture
 * at the same time. `tests/playback.test.ts` covers real files with the mock adapter.
 */

const dir = mkdtempSync(join(tmpdir(), "unifeye-recorded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const files = () => { n++; return { focus: join(dir, `${n}.f`), wall: join(dir, `${n}.w`) }; };

type Channel = "focus" | "wall";
const A = 1_800_000_000_000, B = A + 60_000;
const W = 16, H = 12;

/** A grey picture that depends only on wall-clock time (tenths of a second). */
function picture(ms: number): Uint8Array {
  let seed = Math.round(ms / 100) * 2654435761 % 2 ** 31;
  const px = new Uint8Array(W * H);
  for (let i = 0; i < px.length; i++) { seed = (seed * 1103515245 + 12345) % 2 ** 31; px[i] = seed % 256; }
  return px;
}

/**
 * One channel's export: runs of recorded time ([start ms, seconds]), as 1 s GOPs back to back. Like
 * the recorder's, it starts with the last keyframe at or before the window's start.
 */
function channel(name: Channel, runs: [number, number][], width: number) {
  const gops: Gop[] = [], wallAt: number[] = [];
  let t = 0;
  for (const [at, secs] of runs) for (let k = 0; k < secs; k++) { gops.push({ t, len: 1, hash: `${name === "wall" ? "w" : "h"}${at + k * 1000}` }); wallAt.push(at + k * 1000); t += 1; }
  /** The true wall-clock time at media time s. */
  const wall = (s: number) => { const g = Math.min(gops.length - 1, Math.floor(s + 1e-9)); return wallAt[g] + (s - gops[g].t) * 1000; };
  const thumbs = (keyframes: boolean): Thumbs => {
    const ts = keyframes ? gops.map((g) => g.t) : Array.from({ length: Math.round(t * 10) }, (_, k) => k / 10);
    const px = new Uint8Array(ts.length * W * H);
    ts.forEach((s, k) => px.set(picture(wall(s)), k * W * H));
    return { w: W, h: H, t: ts, px };
  };
  return { gops, end: t, wall, thumbs, info: { start: 0, duration: t, width, audio: true } as MediaInfo };
}
type Fake = ReturnType<typeof channel>;

/** What the recorder has for each channel (its export, or the error its export throws), and its segment lists. */
function recorder(rec: Partial<Record<Channel, Fake | Error>>, lists?: Partial<Record<Channel, [number, number][] | null>>, o: { render?: Error } = {}) {
  const asked: Channel[] = [], rendered: Entry[][] = [], byPath = new Map<string, Fake>(), byName = new Map<string, Fake>();
  const exporter: ExportChannel = async (ch, dest) => {
    asked.push(ch);
    const r = rec[ch] ?? new NoRecordingError();
    if (r instanceof Error) throw r;
    writeFileSync(dest, ch);
    byPath.set(dest, r); byName.set(ch, r);
  };
  // By path, or by what the file says (it may have been renamed).
  const of = (p: string) => { const f = byPath.get(p) ?? byName.get(readFileSync(p, "utf8")); if (!f) throw new Error("no such file"); return f; };
  const ops: MediaOps = {
    probe: async (p) => of(p).info,
    retime: async () => false,
    gops: async (p) => ({ gops: of(p).gops, end: of(p).end }),
    thumbnails: async (p, { keyframes }) => of(p).thumbs(keyframes),
    render: async (base, high, entries, dest) => {
      if (o.render) throw o.render;
      rendered.push(entries);
      writeFileSync(dest, "rendered");
      byPath.set(dest, { ...of(high), info: { ...of(high).info, duration: entries.reduce((s, e) => s + e.len, 0) } });
      return { encoder: "fake", ms: 7 };
    },
  };
  const segments: ListSegments | undefined = lists && (async (ch) => lists[ch] ?? null);
  return { exporter, ops, segments, asked, rendered };
}

const signal = new AbortController().signal;
/** Segments as the recorder lists them: from the first keyframe of each run to its last. */
const segsOf = (runs: [number, number][]): [number, number][] => runs.map(([at, secs]) => [at, at + (secs - 1) * 1000]);

/** Low resolution with a 10 s hole, and high resolution around it (as adaptive recording does around motion). */
const LOW: [number, number][] = [[A, 20], [A + 30_000, 30]];
const HIGH: [number, number][] = [[A - 300_000, 1], [A + 15_000, 20]];

describe("channelsFor", () => {
  it("exports the high channel alone when the low one lists nothing in the window", () => {
    expect(channelsFor([[A - 5000, B]], [], A, B)).toBe("focus");
    expect(channelsFor([[A - 5000, B]], [[A - 60_000, A - 6000], [B, B + 60_000]], A, B)).toBe("focus");
    expect(channelsFor([], [], A, B)).toBe("focus");
  });
  it("exports the low channel alone when the high one lists nothing within a minute", () => {
    expect(channelsFor([[A - 900_000, A - 600_000]], [[A - 1000, B]], A, B)).toBe("wall");
  });
  it("exports both otherwise, since the high channel's times can be many seconds off", () => {
    expect(channelsFor(segsOf(HIGH), segsOf(LOW), A, B)).toBe("both");
    // High seemingly covering the window is not enough: the low channel may hold moments it lacks.
    expect(channelsFor([[A - 5000, B]], [[A, A + 2000]], A, B)).toBe("both");
    // A low segment that ended just before the window still has its last GOP in it.
    expect(channelsFor([[A, B]], [[A - 60_000, A - 3000]], A, B)).toBe("both");
    expect(channelsFor([[A - 110_000, A - 50_000]], [[A, B]], A, B)).toBe("both");
  });
  it("says nothing without both lists", () => {
    expect(channelsFor(null, [[A, B]], A, B)).toBeNull();
    expect(channelsFor([[A, B]], null, A, B)).toBeNull();
  });
});

/** Every second of both files plays exactly once, in order. */
function expectComplete(r: Recorded, base: Fake, high: Fake | null) {
  let b = 0, h = 0;
  for (const e of r.entries) {
    if (e.kind !== "insert") { expect(e.base).toBeCloseTo(b, 3); b = e.base + e.len; }
    if (e.high != null) { expect(e.high).toBeCloseTo(h, 3); h = e.high + e.len; }
  }
  expect(b).toBeCloseTo(base.end, 3);
  if (high) expect(h).toBeCloseTo(high.end, 3);
}

describe("fetchRecorded", () => {
  it("lays the high channel over the low one where they show the same moment, and inserts what the low one lacks", async () => {
    const low = channel("wall", LOW, 640), high = channel("focus", HIGH, 1920), fl = files();
    const f = recorder({ focus: high, wall: low }, { focus: segsOf(HIGH), wall: segsOf(LOW) });
    let early: Recorded | null = null;
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops, segments: f.segments, onBase: (e) => { early = e; } });
    expect(f.asked.sort()).toEqual(["focus", "wall"]);
    expect(r).toMatchObject({ base: fl.wall, high: fl.focus, busy: false, seams: { base: { first: `w${A}`, last: `w${A + 59_000}` }, high: { first: `h${A - 300_000}`, last: `h${A + 34_000}` } } });
    expectComplete(r, low, high);
    const kinds = r.entries.map((e) => [e.kind, e.base, e.high ?? null, e.len, !!e.lead]);
    expect(kinds).toEqual([
      ["insert", 0, 0, 1, true], // the high lead (shown by the stretch before)
      ["base", 0, null, 1, true], // the low lead
      ["base", 1, null, 14, false], // A+1 .. A+15: low only
      ["over", 15, 1, 5, false], // A+15 .. A+20: both
      ["insert", 20, 6, 10, false], // A+20 .. A+30: high only, while the low file waits
      ["over", 20, 16, 5, false], // A+30 .. A+35: both
      ["base", 25, null, 25, false], // the rest: low only
    ]);
    // Wall-clock times follow the recorder: the insert fills the low channel's hole.
    expect(r.entries.map((e) => [e.at, e.span])).toEqual([[A - 300_000, 1000], [A, 1000], [A + 1000, 14_000], [A + 15_000, 5000], [A + 20_000, 10_000], [A + 30_000, 5000], [A + 35_000, 25_000]]);
    expect(coveredMs(r.entries, A, B)).toBe(60_000);
    // Playback could start on the low file before the high one was placed.
    expect(early).toMatchObject({ base: fl.wall, high: null });
    expect(early!.entries.every((e) => e.kind === "base")).toBe(true);
  });

  it("plays the high channel alone when the low one has nothing in the window", async () => {
    const high = channel("focus", [[A - 500, 61]], 1920), fl = files();
    const f = recorder({ focus: high, wall: channel("wall", [[A - 120_000, 30]], 640) }, { focus: [[A - 500, A + 59_500]], wall: [[A - 120_000, A - 91_000]] });
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops, segments: f.segments });
    expect(f.asked).toEqual(["focus"]);
    expect(r).toMatchObject({ base: fl.focus, high: null, seams: { high: null } });
    expect(r.entries.map((e) => [e.kind, e.at, e.len])).toEqual([["base", A - 500, 1], ["base", A + 500, 60]]);
  });

  it("plays the low channel alone when only it has this stretch", async () => {
    const low = channel("wall", [[A - 500, 61]], 640), fl = files();
    const f = recorder({ focus: channel("focus", [[A - 900_000, 5]], 1920), wall: low }, { focus: [[A - 900_000, A - 896_000]], wall: [[A - 500, A + 59_500]] });
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops, segments: f.segments });
    expect(f.asked).toEqual(["wall"]);
    expect(r).toMatchObject({ base: fl.wall, high: null });
  });

  it("keeps the low file alone when channel 0 hands back the same low pictures", async () => {
    const low = channel("wall", LOW, 640), fl = files();
    const f = recorder({ focus: { ...low, info: { ...low.info } }, wall: low }, { focus: segsOf(HIGH), wall: segsOf(LOW) });
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops, segments: f.segments });
    expect(r).toMatchObject({ base: fl.wall, high: null });
  });

  it("plays the low channel alone when the high one has nothing, and says so when it was busy", async () => {
    const lists = { focus: segsOf(HIGH), wall: segsOf(LOW) };
    const none = recorder({ wall: channel("wall", LOW, 640) }, lists);
    expect(await fetchRecorded(none.exporter, A, B, { files: files(), signal, ops: none.ops, segments: none.segments })).toMatchObject({ high: null, busy: false });
    const busy = recorder({ focus: new RecorderBusyError(503), wall: channel("wall", LOW, 640) }, lists);
    expect(await fetchRecorded(busy.exporter, A, B, { files: files(), signal, ops: busy.ops, segments: busy.segments })).toMatchObject({ high: null, busy: true });
  });

  it("plays the high channel alone, as possibly missing time, when the low one keeps failing", async () => {
    const f = recorder({ focus: channel("focus", HIGH, 1920), wall: new RecorderBusyError(503) }, { focus: segsOf(HIGH), wall: segsOf(LOW) }), fl = files();
    expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops, segments: f.segments })).toMatchObject({ base: fl.focus, high: null, busy: true });
  });

  describe("without segment lists", () => {
    it("uses channel 0 alone when it covers the window", async () => {
      const f = recorder({ focus: channel("focus", [[A - 500, 61]], 1920) }), fl = files();
      expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.focus, high: null, busy: false });
      expect(f.asked).toEqual(["focus"]);
    });

    it("adds the low channel when channel 0 comes back short and the low one is longer and smaller", async () => {
      const f = recorder({ focus: channel("focus", HIGH, 1920), wall: channel("wall", LOW, 640) }), fl = files();
      const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops });
      expect(f.asked).toEqual(["focus", "wall"]);
      expect(r).toMatchObject({ base: fl.wall, high: fl.focus });
    });

    it("keeps channel 0 when the low channel is not longer and smaller", async () => {
      for (const wall of [channel("wall", [[A, 22]], 640), channel("wall", LOW, 1920)]) {
        const f = recorder({ focus: channel("focus", HIGH, 1920), wall }), fl = files();
        expect((await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).base).toBe(fl.focus);
      }
    });

    it("falls back to the low channel when channel 0 has nothing or the recorder is busy", async () => {
      for (const focus of [new NoRecordingError(), new RecorderBusyError(500)]) {
        const f = recorder({ focus, wall: channel("wall", [[A - 500, 61]], 640) }), fl = files();
        expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.wall, high: null });
      }
    });
  });

  it("reports the right error when neither channel has the window", async () => {
    const empty = recorder({});
    await expect(fetchRecorded(empty.exporter, A, B, { files: files(), signal, ops: empty.ops })).rejects.toMatchObject({ name: "NoRecordingError" });
    // Busy, then nothing on the low channel: the busy answer stands.
    const b = recorder({ focus: new RecorderBusyError(503) });
    await expect(fetchRecorded(b.exporter, A, B, { files: files(), signal, ops: b.ops })).rejects.toMatchObject({ name: "RecorderBusyError" });
    // Nothing, then a real failure on the low channel: the failure is the problem.
    const c = recorder({ wall: new Error("connection reset") });
    await expect(fetchRecorded(c.exporter, A, B, { files: files(), signal, ops: c.ops })).rejects.toThrow("connection reset");
    // Any other channel 0 failure is not papered over.
    const d = recorder({ focus: new Error("sign-in failed"), wall: channel("wall", LOW, 640) });
    await expect(fetchRecorded(d.exporter, A, B, { files: files(), signal, ops: d.ops })).rejects.toThrow("sign-in failed");
    expect(d.asked).toEqual(["focus"]);
  });

  it("keeps an export whose retime fails, but stops when cancelled during one", async () => {
    const f = recorder({ focus: channel("focus", [[A - 500, 61]], 1920) }), fl = files();
    f.ops.retime = async () => { throw new Error("ffmpeg exited 1"); };
    expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.focus, high: null });
    const ac = new AbortController(), g = recorder({ focus: channel("focus", [[A, 60]], 1920) });
    g.ops.retime = async () => { ac.abort(); throw new Error("ffmpeg killed"); };
    await expect(fetchRecorded(g.exporter, A, B, { files: files(), signal: ac.signal, ops: g.ops })).rejects.toThrow("ffmpeg killed");
  });
});

describe("fetchRecordedFile", () => {
  const lists = { focus: segsOf(HIGH), wall: segsOf(LOW) };

  it("renders an adaptive recording in playback order, without its lead when the piece before has it", async () => {
    const f = recorder({ focus: channel("focus", HIGH, 1920), wall: channel("wall", LOW, 640) }, lists), path = join(dir, "combined.mp4");
    // The clip's first piece keeps the low lead only: the high one may be from well before the clip.
    let seams: Seams | null = null;
    const first = await fetchRecordedFile(f.exporter, A, B, join(dir, "first.mp4"), { files: files(), signal, ops: f.ops, segments: f.segments, onFetched: (s) => { seams = s; } });
    expect(f.rendered[0].filter((e) => e.lead).map((e) => e.kind)).toEqual(["base"]);
    expect(first.entries).toEqual(f.rendered[0]);
    // After a piece that ended with the same low keyframe: no lead at all.
    const ended = (last: string): Promise<Seams> => Promise.resolve({ base: { first: "", last }, high: { first: "", last: seams!.high!.first } });
    const r = await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops, segments: f.segments, before: ended(seams!.base.first) });
    expect(readFileSync(path, "utf8")).toBe("rendered");
    expect(f.rendered[1].some((e) => e.lead)).toBe(false);
    expect(r).toMatchObject({ rendered: true, busy: false, coveredMs: 60_000, combineMs: 7, info: { width: 1920 } });
    // After a piece that ended elsewhere (only the high keyframe matching), or none: the low lead is kept.
    await fetchRecordedFile(f.exporter, A, B, join(dir, "other.mp4"), { files: files(), signal, ops: f.ops, segments: f.segments, before: ended("elsewhere") });
    await fetchRecordedFile(f.exporter, A, B, join(dir, "alone.mp4"), { files: files(), signal, ops: f.ops, segments: f.segments, before: Promise.resolve(null) });
    for (const es of f.rendered.slice(2)) expect(es.filter((e) => e.lead).map((e) => e.kind)).toEqual(["base"]);
  });

  it("saves the low channel when rendering fails, reporting its lead", async () => {
    const f = recorder({ focus: channel("focus", HIGH, 1920), wall: channel("wall", LOW, 640) }, lists, { render: new Error("cannot encode hevc") }), path = join(dir, "low.mp4");
    const r = await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops, segments: f.segments });
    expect(readFileSync(path, "utf8")).toBe("wall");
    // The low channel's hole is missing from this file.
    expect(r).toMatchObject({ rendered: false, combineMs: 0, coveredMs: 50_000, info: { width: 640 } });
    expect(r.entries.filter((e) => e.lead)).toMatchObject([{ kind: "base", len: 1 }]);
  });

  it("keeps a plain export as it is, and passes on that time may be missing", async () => {
    const f = recorder({ focus: channel("focus", HIGH, 1920), wall: new RecorderBusyError(503) }, lists), path = join(dir, "busy.mp4");
    const r = await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops, segments: f.segments });
    expect(r).toMatchObject({ busy: true, rendered: false });
    expect(r.entries.filter((e) => e.lead)).toMatchObject([{ kind: "base", len: 1 }]);
    expect(readFileSync(path, "utf8")).toBe("focus");
  });
});

describe("fetchRecorded with the recorder's times", () => {
  /**
   * A recorder that names each GOP's time (its stamp), as Protect's playback stream does: GOPs of 1 s
   * recorded at `keys` on each channel, the high channel's stamped `lagMs` late. An export (and its
   * stamps) of [start, end), widened by its reach, holds the GOPs stamped inside it, led by the last
   * one stamped before it.
   */
  function stamping(keys: Record<Channel, number[]>, o: { lagMs?: number; stamps?: (ch: Channel, s: number[], reach?: Reach) => number[] | null; fail?: (ch: Channel, reach?: Reach) => Error | null } = {}) {
    const exported: [Channel, Reach | undefined][] = [], stamped: [Channel, Reach | undefined][] = [], byPath = new Map<string, Fake>(), byName = new Map<string, Fake>();
    const stampOf = (ch: Channel, k: number) => k + (ch === "focus" ? o.lagMs ?? 6000 : 0);
    const pick = (ch: Channel, reach?: Reach) => {
      const a = A - (reach?.beforeMs ?? 0), b = B + (reach?.afterMs ?? 0), all = keys[ch], s = all.map((k) => stampOf(ch, k));
      const first = Math.max(0, s.findLastIndex((x) => x < a));
      const n = s.slice(first).findIndex((x) => x >= b);
      const end = n < 0 ? all.length : first + Math.max(1, n);
      return { keys: all.slice(first, end), stamps: s.slice(first, end) };
    };
    const exporter: ExportChannel = async (ch, dest, _signal, reach) => {
      exported.push([ch, reach]);
      const err = o.fail?.(ch, reach);
      if (err) throw err;
      const { keys: ks } = pick(ch, reach);
      if (!ks.length) throw new NoRecordingError();
      writeFileSync(dest, ch);
      byPath.set(dest, channel(ch, ks.map((k) => [k, 1]), ch === "focus" ? 1920 : 640));
      if (!reach) byName.set(ch, byPath.get(dest)!);
    };
    const stamps: ListStamps = async (ch, _signal, reach) => {
      stamped.push([ch, reach]);
      const s = pick(ch, reach).stamps;
      return o.stamps ? o.stamps(ch, s, reach) : s;
    };
    // By path, or by what the file says (a piece is renamed into place).
    const of = (p: string) => { const f = byPath.get(p) ?? byName.get(readFileSync(p, "utf8")); if (!f) throw new Error("no such file"); return f; };
    const ops: MediaOps = {
      probe: async (p) => of(p).info,
      retime: async () => false,
      gops: async (p) => ({ gops: of(p).gops, end: of(p).end }),
      thumbnails: async (p, { keyframes }) => of(p).thumbs(keyframes),
      render: async () => { throw new Error("not used"); },
    };
    /** Segment lists in each channel's own time, as the recorder gives them. */
    const runsOf = (ch: Channel): [number, number][] => {
      const out: [number, number][] = [];
      for (const k of keys[ch]) { const s = stampOf(ch, k), r = out[out.length - 1]; if (r && s - r[1] <= 1500) r[1] = s; else out.push([s, s]); }
      return out;
    };
    const segments: ListSegments = async (ch) => runsOf(ch);
    return { exporter, stamps, ops, segments, exported, stamped, of };
  }
  const every = (a: number, b: number) => Array.from({ length: Math.round((b - a) / 1000) }, (_, k) => a + k * 1000);
  // Low resolution all along but for 10 s of motion; high resolution around that hole, a lead long
  // before, and a run recorded just after the window (stamped inside the high file's reach).
  const LOW_KEYS = [...every(A - 120_000, A + 20_000), ...every(A + 30_000, B + 120_000)];
  const HIGH_KEYS = [A - 300_000, ...every(A + 15_000, A + 35_000), ...every(B + 5000, B + 10_000)];
  const R = highReachMs();
  const withContext = () => { const fl = files(); return { ...fl, context: `${fl.wall}.c` }; };
  const run = (r: ReturnType<typeof stamping>, fl: { focus: string; wall: string; context?: string }, o: { stamps?: boolean; onBase?: (e: Recorded) => void } = {}) =>
    fetchRecorded(r.exporter, A, B, { files: fl, signal, ops: r.ops, segments: r.segments, stamps: o.stamps === false ? undefined : r.stamps, onBase: o.onBase });
  /** kind, seconds into the window and seconds long of each entry, to the tenth. */
  const timed = (es: Entry[]) => es.map((e) => [e.kind, Math.round((e.at - A) / 100) / 10, Math.round(e.span / 100) / 10, !!e.lead]);

  it("exports the high channel past the stretch and the low one around it, and places by the stamps", async () => {
    const r = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }), fl = withContext();
    let early: Recorded | null = null;
    const got = await run(r, fl, { onBase: (e) => { early = e; } });
    const wide = { beforeMs: R, afterMs: R };
    expect(r.exported).toEqual(expect.arrayContaining([["focus", { afterMs: R }], ["wall", undefined], ["wall", wide]]));
    expect(r.exported).toHaveLength(3);
    expect(r.stamped).toEqual(expect.arrayContaining([["focus", { afterMs: R }], ["wall", undefined], ["wall", wide]]));
    expect(got).toMatchObject({ base: fl.wall, high: fl.focus, busy: false });
    // The high file holds the run recorded after the window, which plays in the window after.
    expect(r.of(fl.focus).gops.length).toBe(1 + 20 + 5);
    expect(timed(got.entries)).toEqual([
      ["base", -1, 1, true], ["base", 0, 15, false], ["over", 15, 5, false], ["insert", 20, 10, false], ["over", 30, 5, false], ["base", 35, 25, false],
    ]);
    // The base was dated by its stamps before the high file was placed.
    expect(timed(early!.entries)).toEqual([["base", -1, 1, true], ["base", 0, 20, false], ["base", 30, 30, false]]);
  });

  it("re-exports the high channel without reach and places the old way when its stamps don't fit", async () => {
    const old = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }), plain = await run(old, files(), { stamps: false });
    const short = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }, { stamps: (ch, s) => (ch === "focus" ? s.slice(1) : s) });
    const contextFails = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }, { fail: (ch, reach) => (ch === "wall" && reach ? new RecorderBusyError(503) : null) });
    const lowWrong = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }, { stamps: (ch, s, reach) => (ch === "wall" && !reach ? [...s].reverse() : s) });
    for (const r of [short, contextFails, lowWrong]) {
      const fl = withContext(), got = await run(r, fl);
      expect(r.exported.filter(([ch]) => ch === "focus")).toEqual([["focus", { afterMs: R }], ["focus", undefined]]);
      expect(r.of(fl.focus).gops.length).toBe(1 + 20);
      expect(got.entries).toEqual(plain.entries);
    }
  });

  it("changes nothing without a file for the context or without stamps", async () => {
    const old = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }), plain = await run(old, files(), { stamps: false });
    expect(old.exported).toEqual(expect.arrayContaining([["focus", undefined], ["wall", undefined]]));
    expect(old.stamped).toEqual([]);
    const r = stamping({ wall: LOW_KEYS, focus: HIGH_KEYS }), got = await run(r, files());
    expect(r.exported.map(([, reach]) => reach)).toEqual([undefined, undefined]);
    expect(got.entries).toEqual(plain.entries);
  });

  it("dates the low channel by its stamps when it is exported alone", async () => {
    // The high channel lists nothing near the window, so the low one is played alone; its segment
    // list hides the hole, which the stamps show.
    const r = stamping({ wall: LOW_KEYS, focus: [A - 900_000] }), fl = withContext();
    const got = await fetchRecorded(r.exporter, A, B, { files: fl, signal, ops: r.ops, segments: async (ch) => (ch === "wall" ? [[A - 120_000, B + 119_000]] : [[A - 894_000, A - 894_000]]), stamps: r.stamps });
    expect(r.exported).toEqual([["wall", undefined]]);
    expect(r.stamped).toEqual([["wall", undefined]]);
    expect(got).toMatchObject({ base: fl.wall, high: null });
    expect(timed(got.entries)).toEqual([["base", -1, 1, true], ["base", 0, 20, false], ["base", 30, 30, false]]);
  });

  // A plain piece of a clip is kept whole, so the piece before ends with all of its last GOP, and
  // the join cuts the next piece's whole lead GOP (`startAfter`).
  it("flags the whole first GOP of a plain piece as its lead, as the piece before shows all of it", async () => {
    const r = stamping({ wall: LOW_KEYS.map((k) => k - 500), focus: [A - 900_000] });
    const piece = await fetchRecordedFile(r.exporter, A, B, join(dir, "plain-stamped.mp4"), { files: withContext(), signal, ops: r.ops, segments: async (ch) => (ch === "wall" ? [[A - 120_500, B + 118_500]] : [[A - 894_000, A - 894_000]]), stamps: r.stamps });
    expect(piece.rendered).toBe(false);
    expect(piece.entries.filter((e) => e.lead).reduce((s, e) => s + e.len, 0)).toBeCloseTo(1, 3);
  });
});
