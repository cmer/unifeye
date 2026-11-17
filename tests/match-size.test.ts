import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { SizeMatcher } from "@/server/media/match-size";
import { encoderFor } from "@/server/protect/encoders";
import { ffmpeg, joinParts, overlayStretches, probe, videoSizes } from "@/server/protect/ffmpeg";
import { TEST_ENV } from "@/server/testing/fixture";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "unifeye-size-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => setConfigForTests(loadConfig(TEST_ENV)));

/** 6 s of video and audio on Protect's 1/1000 video timescale, keyframe every 2 s. */
async function clip(name: string, size: string, fps = 7) {
  const path = join(dir, name);
  await ffmpeg(["-f", "lavfi", "-i", `testsrc=s=${size}:r=${fps}:d=6`, "-f", "lavfi", "-i", "sine=d=6:sample_rate=16000", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", String(fps * 2), "-c:a", "aac", "-video_track_timescale", "1000", "-f", "mp4", "-y", path]);
  return path;
}
/** Every decoded frame's size, with how many frames had it. */
const frameSizes = (path: string) => {
  const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "frame=width,height", "-of", "csv=p=0", path]).toString();
  const n = new Map<string, number>();
  for (const l of out.split("\n")) { const [w, h] = l.split(","); if (w && h) n.set(`${w}x${h}`, (n.get(`${w}x${h}`) ?? 0) + 1); }
  return Object.fromEntries(n);
};
const frameTimes = (path: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", path]).toString().split("\n").filter(Boolean).map(Number).sort((a, b) => a - b);
const streams = (path: string) => execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,start_time", "-of", "csv=p=0", path]).toString().trim();
const timeBase = (path: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base", "-of", "csv=p=0", path]).toString().trim();

describe.skipIf(!hasFfmpeg)("matching picture sizes across a clip's pieces", () => {
  it("reads every size in a file, including one that changes partway", async () => {
    const mixed = join(dir, "mixed.mp4");
    await joinParts([{ path: await clip("m1.mp4", "640x480") }, { path: await clip("m2.mp4", "1280x720", 15) }], mixed);
    expect(await videoSizes(mixed)).toEqual({ codec: "h264", sizes: [{ w: 640, h: 480 }, { w: 1280, h: 720 }] });
  });

  // `auto` is whatever GPU the test machine has (VideoToolbox on a Mac), or the CPU.
  it.each(["cpu", "auto"])("resizes the smaller pieces to the largest, so the joined clip plays at one size (%s)", async (encoder) => {
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: encoder } as unknown as NodeJS.ProcessEnv));
    const at = (name: string) => `${encoder}-${name}`;
    const low = await clip(at("low.mp4"), "640x480"), high = await clip(at("high.mp4"), "1280x720", 15), mid = await clip(at("mid.mp4"), "960x540"), mixed = join(dir, at("mixed2.mp4"));
    await joinParts([{ path: await clip(at("x1.mp4"), "640x480") }, { path: await clip(at("x2.mp4"), "1280x720", 15) }], mixed);
    const m = new SizeMatcher(new AbortController().signal);
    // Arrival order is up to the downloads; the biggest piece is not first.
    for (const p of [low, mid, high, mixed]) m.add(p);
    const fitted = await m.finish();
    expect([...fitted.keys()].sort()).toEqual([low, mid, mixed].sort());
    for (const [src, path] of fitted) {
      expect(frameSizes(path)).toEqual({ "1280x720": Object.values(frameSizes(src)).reduce((a, b) => a + b) }); // every frame kept, at the new size
      expect(frameTimes(path)).toEqual(frameTimes(src)); // and at its time, so the cut between pieces does not move
      expect(streams(path)).toEqual(streams(src)); // sound kept, video still starts where it did
      expect(timeBase(path)).toBe(timeBase(src));
    }
    const out = join(dir, at("joined.mp4"));
    await joinParts([low, high, mid, mixed].map((p) => ({ path: fitted.get(p) ?? p })), out);
    expect(Object.keys(frameSizes(out))).toEqual(["1280x720"]);
    expect((await probe(out)).duration).toBeCloseTo(30, 0);
    await m.cleanup();
    for (const path of fitted.values()) expect(existsSync(path)).toBe(false);
  }, 60_000);

  it("keeps H.265 pieces in H.265", async () => {
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: "cpu" } as unknown as NodeJS.ProcessEnv));
    const hevc = async (name: string, size: string) => { const p = join(dir, name); await ffmpeg(["-i", await clip(`src-${name}`, size), "-map", "0", "-c:a", "copy", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-video_track_timescale", "1000", "-f", "mp4", "-y", p]); return p; };
    const low = await hevc("h-low.mp4", "640x480"), m = new SizeMatcher(new AbortController().signal);
    m.add(low); m.add(await hevc("h-high.mp4", "1280x720"));
    const out = (await m.finish()).get(low)!;
    expect(await videoSizes(out)).toEqual({ codec: "hevc", sizes: [{ w: 1280, h: 720 }] });
    await m.cleanup();
  }, 60_000);

  it("leaves pieces alone when they already match", async () => {
    const m = new SizeMatcher(new AbortController().signal);
    m.add(await clip("same1.mp4", "640x360")); m.add(await clip("same2.mp4", "640x360"));
    expect((await m.finish()).size).toBe(0);
    expect(m.done).toBe(0);
  });

  it("stops when the clip is cancelled", async () => {
    const ac = new AbortController(), m = new SizeMatcher(ac.signal);
    m.add(await clip("c1.mp4", "1280x720", 15)); m.add(await clip("c2.mp4", "640x480"));
    ac.abort();
    await expect(m.finish()).rejects.toThrow();
    await m.cleanup();
  });

  it("uses the CPU when asked, or when the named GPU encoder is not there", async () => {
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: "cpu" } as unknown as NodeJS.ProcessEnv));
    expect((await encoderFor("h264")).name).toBe("libx264");
    expect((await encoderFor("hevc")).name).toBe("libx265");
    // No test machine has an NVIDIA GPU, and VAAPI with a missing device cannot open.
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: "vaapi", VAAPI_DEVICE: join(dir, "no-such-device") } as unknown as NodeJS.ProcessEnv));
    expect((await encoderFor("h264")).name).toBe("libx264");
  }, 60_000);
});

describe.skipIf(!hasFfmpeg)("combining an adaptive recording's two exports", () => {
  /** Average colour of the frame shown at `t` seconds. */
  const colour = (path: string, t: number) => [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
  const isRed = (c: number[]) => c[0] > 150 && c[2] < 80, isBlue = (c: number[]) => c[2] > 150 && c[0] < 80;

  it("shows the high-resolution stretches at their places over the whole low-resolution recording", async () => {
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: "cpu" } as unknown as NodeJS.ProcessEnv));
    // Low: 60 s of red at 640x480, 7 fps. High: two 9 s stretches of blue at 1280x720, 15 fps, joined,
    // that belong at 12-21 s and 42-51 s.
    const base = join(dir, "ov-base.mp4"), high = join(dir, "ov-high.mp4"), out = join(dir, "ov-out.mp4");
    await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=640x480:r=7:d=60", "-f", "lavfi", "-i", "sine=d=60:sample_rate=16000", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "14", "-c:a", "aac", "-video_track_timescale", "1000", "-f", "mp4", "-y", base]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=1280x720:r=15:d=18", "-f", "lavfi", "-i", "sine=d=18:sample_rate=16000", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "30", "-c:a", "aac", "-video_track_timescale", "1000", "-f", "mp4", "-y", high]);
    await overlayStretches(base, high, [{ at: 12, from: 0, len: 9 }, { at: 42, from: 9, len: 9 }], out, await encoderFor("h264"));
    expect(Object.keys(frameSizes(out))).toEqual(["1280x720"]);
    expect(streams(out)).toEqual(streams(base)); // the low recording's sound, from the start
    expect((await probe(out)).duration).toBeCloseTo(60, 0);
    for (const t of [5, 11.7, 21.3, 30, 41.7, 51.3, 58]) expect(isRed(colour(out, t)), `red at ${t}`).toBe(true);
    for (const t of [12.3, 16, 20.7, 42.3, 50.7]) expect(isBlue(colour(out, t)), `blue at ${t}`).toBe(true);
    // The high stretches keep their frame rate: 15 fps, not the low recording's 7.
    const times = frameTimes(out).filter((t) => t >= 13 && t < 20);
    expect(times.length).toBeGreaterThanOrEqual(7 * 15 - 2);
  }, 60_000);
});
