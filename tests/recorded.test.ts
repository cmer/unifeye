import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { MediaInfo } from "@/server/protect/ffmpeg";
import { NoRecordingError, RecorderBusyError } from "@/server/protect/types";
import { fetchRecorded, fetchRecordedFile, leadOf, type ExportChannel, type MediaOps } from "@/server/media/recorded";

/**
 * The adaptive-recording decisions, driven by a fake recorder and fake media operations: no FFmpeg.
 * `tests/playback.test.ts` and `tests/match-size.test.ts` cover the real media with the mock adapter.
 */

const dir = mkdtempSync(join(tmpdir(), "unifeye-recorded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const files = () => { n++; return { focus: join(dir, `${n}.f`), wall: join(dir, `${n}.w`) }; };

/** Loudness curve made of random 50 ms steps, like speech or playground noise. */
function noise(len: number, seed: number) {
  const out = new Float64Array(len); let v = 0;
  for (let i = 0; i < len; i++) { if (i % 5 === 0) { seed = (seed * 1103515245 + 12345) % 2 ** 31; v = (seed / 2 ** 31) * 6; } out[i] = v; }
  return out;
}

type Channel = "focus" | "wall";
/** What the recorder has for each channel: a file's info, or the error its export throws. */
type Recorder = Partial<Record<Channel, MediaInfo | Error>>;
const HI = (duration: number, audio = true): MediaInfo => ({ start: 0, duration, width: 1920, audio });
const LO = (duration: number, audio = true): MediaInfo => ({ start: 0, duration, width: 640, audio });

function fake(rec: Recorder, opts: { envelope?: Partial<Record<Channel, Float64Array>>; combine?: Error } = {}) {
  const asked: Channel[] = [], retimed: string[] = [], trail: string[] = [], infos = new Map<string, MediaInfo>();
  const exporter: ExportChannel = async (ch, dest) => {
    asked.push(ch);
    const r = rec[ch] ?? new NoRecordingError();
    if (r instanceof Error) throw r;
    writeFileSync(dest, ch);
    infos.set(dest, r);
    trail.push(`export ${ch}`);
  };
  const channelOf = (p: string): Channel => (readFileSync(p, "utf8").startsWith("focus") ? "focus" : "wall");
  const ops: MediaOps = {
    probe: async (p) => { trail.push(`probe ${channelOf(p)}`); const i = infos.get(p); if (!i) throw new Error("no such file"); return i; },
    retime: async (p) => { retimed.push(p); trail.push(`retime ${channelOf(p)}`); return false; },
    envelope: async (p) => opts.envelope?.[channelOf(p)] ?? new Float64Array(0),
    combine: async (base, high, spans, dest) => {
      if (opts.combine) throw opts.combine;
      writeFileSync(dest, `combined ${spans.length}`);
      infos.set(dest, { ...infos.get(base)!, width: infos.get(high)!.width });
      return { encoder: "fake", ms: 7 };
    },
  };
  return { exporter, ops, asked, retimed, trail };
}

const signal = new AbortController().signal;
const A = 1_000_000, B = A + 60_000;

describe("fetchRecorded", () => {
  it("uses channel 0 alone when it covers the window, with the keyframe lead", async () => {
    const f = fake({ focus: HI(62.5) }), fl = files();
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops });
    expect(r).toMatchObject({ base: fl.focus, high: null, overlay: [], leadMs: 2500, busy: false });
    expect(f.asked).toEqual(["focus"]);
    expect(f.retimed).toEqual([fl.focus]);
  });

  it("keeps channel 0 when it is short by a second or less", async () => {
    const f = fake({ focus: HI(59.2), wall: LO(60) });
    const r = await fetchRecorded(f.exporter, A, B, { files: files(), signal, ops: f.ops });
    expect(f.asked).toEqual(["focus"]);
    expect(r.leadMs).toBe(0);
  });

  it("lays the high-resolution stretches over the low channel when their audio places them", async () => {
    const base = noise(6200, 7), high = base.slice(1400, 3200);
    const f = fake({ focus: HI(18), wall: LO(62) }, { envelope: { focus: high, wall: base } }), fl = files();
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops });
    expect(r).toMatchObject({ base: fl.wall, high: fl.focus, leadMs: 2000, busy: false });
    expect(r.overlay).toEqual([{ at: 14, from: 0, len: 18 }]);
    // Both exports are retimed before anything reads them.
    expect(f.retimed).toEqual([fl.focus, fl.wall]);
    expect(f.trail).toEqual(["export focus", "retime focus", "probe focus", "export wall", "retime wall", "probe wall"]);
  });

  it("plays the low channel alone when the audio cannot place the high-resolution part", async () => {
    const f = fake({ focus: HI(18, false), wall: LO(62) }), fl = files();
    const r = await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops });
    expect(r).toMatchObject({ base: fl.wall, high: null, overlay: [] });
  });

  it("keeps channel 0 when the low channel is not longer and smaller", async () => {
    for (const wall of [LO(19), HI(62)]) {
      const f = fake({ focus: HI(18), wall }), fl = files();
      expect((await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).base).toBe(fl.focus);
    }
  });

  it("says the result may be missing time when the low channel was needed but kept failing", async () => {
    const busy = fake({ focus: HI(18), wall: new RecorderBusyError(503) });
    expect(await fetchRecorded(busy.exporter, A, B, { files: files(), signal, ops: busy.ops })).toMatchObject({ busy: true, high: null });
    const none = fake({ focus: HI(18) });
    expect(await fetchRecorded(none.exporter, A, B, { files: files(), signal, ops: none.ops })).toMatchObject({ busy: false });
  });

  it("falls back to the low channel when channel 0 has nothing or the recorder is busy", async () => {
    for (const focus of [new NoRecordingError(), new RecorderBusyError(500)]) {
      const f = fake({ focus, wall: LO(61) }), fl = files();
      expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.wall, high: null, leadMs: 1000 });
    }
  });

  it("reports the right error when neither channel has the window", async () => {
    // Nothing on either: "nothing recorded".
    await expect(fetchRecorded(fake({}).exporter, A, B, { files: files(), signal, ops: fake({}).ops })).rejects.toMatchObject({ name: "NoRecordingError" });
    // Busy, then nothing on the low channel: the busy answer stands.
    const b = fake({ focus: new RecorderBusyError(503) });
    await expect(fetchRecorded(b.exporter, A, B, { files: files(), signal, ops: b.ops })).rejects.toMatchObject({ name: "RecorderBusyError" });
    // Nothing, then a real failure on the low channel: the failure is the problem.
    const c = fake({ wall: new Error("connection reset") });
    await expect(fetchRecorded(c.exporter, A, B, { files: files(), signal, ops: c.ops })).rejects.toThrow("connection reset");
    // Any other channel 0 failure is not papered over.
    const d = fake({ focus: new Error("sign-in failed"), wall: LO(60) });
    await expect(fetchRecorded(d.exporter, A, B, { files: files(), signal, ops: d.ops })).rejects.toThrow("sign-in failed");
    expect(d.asked).toEqual(["focus"]);
  });

  it("keeps an export whose retime fails", async () => {
    const f = fake({ focus: HI(61.5) }), fl = files();
    f.ops.retime = async () => { throw new Error("ffmpeg exited 1"); };
    expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.focus, high: null, overlay: [], leadMs: 1500, busy: false });
  });

  it("stops when cancelled during a retime, rather than carrying on with an unrepaired file", async () => {
    const ac = new AbortController(), f = fake({ focus: HI(60) });
    f.ops.retime = async () => { ac.abort(); throw new Error("ffmpeg killed"); };
    await expect(fetchRecorded(f.exporter, A, B, { files: files(), signal: ac.signal, ops: f.ops })).rejects.toThrow("ffmpeg killed");
  });

  it("keeps channel 0, with no lead, when it cannot be read", async () => {
    const f = fake({ focus: HI(60), wall: LO(62) }), fl = files();
    f.ops.probe = async () => { throw new Error("ffprobe exited 1"); };
    expect(await fetchRecorded(f.exporter, A, B, { files: fl, signal, ops: f.ops })).toMatchObject({ base: fl.focus, info: null, leadMs: 0, high: null });
    expect(f.asked).toEqual(["focus"]);
  });

  it("asks for the low channel only when channel 0 is more than a second short, and uses it only when more than 2 s longer", async () => {
    const exactly = fake({ focus: HI(59), wall: LO(62) });
    await fetchRecorded(exactly.exporter, A, B, { files: files(), signal, ops: exactly.ops });
    expect(exactly.asked).toEqual(["focus"]);
    const short = fake({ focus: HI(58.9), wall: LO(60.9) }), fl = files();
    expect((await fetchRecorded(short.exporter, A, B, { files: fl, signal, ops: short.ops })).base).toBe(fl.focus); // exactly 2 s longer: not enough
    expect(short.asked).toEqual(["focus", "wall"]);
  });
});

describe("fetchRecordedFile", () => {
  const base = noise(6200, 7), high = base.slice(1400, 3200);

  it("combines an adaptive recording into one file", async () => {
    const f = fake({ focus: HI(18), wall: LO(62) }, { envelope: { focus: high, wall: base } }), path = join(dir, "combined.mp4");
    const r = await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops });
    expect(readFileSync(path, "utf8")).toBe("combined 1");
    expect(r).toMatchObject({ leadMs: 2000, busy: false, combineMs: 7, info: { width: 1920 } });
  });

  it("saves the low channel when combining fails, so no time is missing", async () => {
    const f = fake({ focus: HI(18), wall: LO(62) }, { envelope: { focus: high, wall: base }, combine: new Error("cannot encode hevc") }), path = join(dir, "low.mp4");
    const r = await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops });
    expect(readFileSync(path, "utf8")).toBe("wall");
    expect(r).toMatchObject({ leadMs: 2000, combineMs: 0, info: { width: 640 } });
  });

  it("passes on that time may be missing", async () => {
    const f = fake({ focus: HI(18), wall: new RecorderBusyError(503) }), path = join(dir, "busy.mp4");
    expect(await fetchRecordedFile(f.exporter, A, B, path, { files: files(), signal, ops: f.ops })).toMatchObject({ busy: true, leadMs: 0 });
    expect(readFileSync(path, "utf8")).toBe("focus");
  });
});

describe("leadOf", () => {
  it("is how much longer than asked the file is, from 0 to 10 s", () => {
    expect(leadOf(62.4, A, B)).toBe(2400);
    expect(leadOf(58, A, B)).toBe(0);
    expect(leadOf(90, A, B)).toBe(10_000);
  });
});
