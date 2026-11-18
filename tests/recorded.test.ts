import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MediaInfo } from "@/server/protect/ffmpeg";
import { NoRecordingError, RecorderBusyError } from "@/server/protect/types";
import { channelsFor, coveredMs, fetchRecorded, fetchRecordedFile, type Entry, type ExportChannel, type ListSegments, type MediaOps, type Recorded } from "@/server/media/recorded";
import type { Thumbs } from "@/server/media/placement";
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
