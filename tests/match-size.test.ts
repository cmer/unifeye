import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, setConfigForTests } from "@/server/config";
import { SizeMatcher } from "@/server/media/match-size";
import { encoderFor } from "@/server/protect/encoders";
import { ffmpeg, joinParts, probe, renderEntries, videoSizes } from "@/server/protect/ffmpeg";
import type { Entry } from "@/server/media/timeline";
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

describe.skipIf(!hasFfmpeg)("rendering an adaptive recording's two exports in playback order", () => {
  /** Average colour of the frame shown at `t` seconds. */
  const colour = (path: string, t: number) => [...execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", path, "-frames:v", "1", "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])];
  const is: Record<string, (c: number[]) => boolean> = {
    red: ([r, g, b]) => r > 150 && g < 80 && b < 80, yellow: ([r, g, b]) => r > 150 && g > 150 && b < 80,
    blue: ([r, , b]) => b > 150 && r < 80, green: ([r, g, b]) => g > 90 && r < 80 && b < 80,
  };
  /** 20 s of one colour, then 20 s (or `secs`) of another, with sound. */
  const twoColours = async (path: string, a: string, b: string, size: string, fps: number, secs = 20) => {
    const src = (c: string) => ["-f", "lavfi", "-i", `color=c=${c}:s=${size}:r=${fps}:d=${secs}`];
    await ffmpeg([...src(a), ...src(b), "-f", "lavfi", "-i", `sine=d=${2 * secs}:sample_rate=16000`, "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-bf", "0", "-g", String(fps), "-c:a", "aac", "-video_track_timescale", "1000", "-f", "mp4", "-y", path]);
  };

  it("plays each file's stretches in turn, at the high resolution, keeping the low file's sound", async () => {
    setConfigForTests(loadConfig({ ...TEST_ENV, VIDEO_ENCODER: "cpu" } as unknown as NodeJS.ProcessEnv));
    // Low: red then yellow, 640x480 at 7 fps. High: blue then green, 1280x720 at 15 fps, 10 s each.
    const base = join(dir, "r-base.mp4"), high = join(dir, "r-high.mp4"), out = join(dir, "r-out.mp4");
    await twoColours(base, "red", "yellow", "640x480", 7);
    await twoColours(high, "blue", "green", "1280x720", 15, 10);
    const e = (kind: Entry["kind"], b: number, len: number, h?: number): Entry => ({ kind, base: b, len, at: 0, span: 0, ...(h != null ? { high: h } : {}) });
    const entries = [e("base", 0, 10), e("over", 10, 5, 0), e("insert", 15, 5, 5), e("base", 15, 10), e("over", 25, 5, 10), e("insert", 30, 5, 15), e("base", 30, 10)];
    await renderEntries(base, high, entries, out, await encoderFor("h264"));
    expect(Object.keys(frameSizes(out))).toEqual(["1280x720"]);
    expect(streams(out)).toContain("audio");
    expect((await probe(out)).duration).toBeCloseTo(50, 0);
    const want: [number, string][] = [[5, "red"], [9.7, "red"], [10.3, "blue"], [17, "blue"], [19.7, "blue"], [20.3, "red"], [27, "yellow"], [32, "green"], [37, "green"], [39.7, "green"], [40.3, "yellow"], [48, "yellow"]];
    for (const [t, c] of want) expect(is[c](colour(out, t)), `${c} at ${t}`).toBe(true);
    // The high stretches keep their frame rate: 15 fps, not the low recording's 7.
    expect(frameTimes(out).filter((t) => t >= 11 && t < 19).length).toBeGreaterThanOrEqual(8 * 15 - 2);
  }, 60_000);
});
