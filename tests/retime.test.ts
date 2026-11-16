import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ffmpeg, joinParts, retimeVideoToAudio } from "../src/server/protect/ffmpeg";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "vantage-retime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const durations = (path: string) => {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path]).toString()) as { streams: { codec_type: string; duration: string }[] };
  return Object.fromEntries(out.streams.map((s) => [s.codec_type, Number(s.duration)]));
};
const videoTimeBase = (path: string) => execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=time_base", "-of", "csv=p=0", path]).toString().trim();
const formatDuration = (path: string) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).toString());
/**
 * 12 s of 7 fps video and 12 s of audio on Protect's 1/1000 video timescale; `fast` stamps the video
 * at 11 fps, as Protect does for an adaptive Low channel.
 */
async function clip(name: string, fast: boolean) {
  const path = join(dir, name);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x240:r=7:d=12", "-f", "lavfi", "-i", "sine=d=12:sample_rate=16000", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-g", "28", "-c:a", "aac", "-video_track_timescale", "1000",
    ...(fast ? ["-bsf:v", `setts=ts=N*${(1 / 11).toFixed(6)}/TB`] : []), "-f", "mp4", "-y", path]);
  return path;
}

describe.skipIf(!hasFfmpeg)("retimeVideoToAudio", () => {
  it("spreads a too-fast video clock across the audio's span", async () => {
    const path = await clip("fast.mp4", true);
    const before = durations(path);
    expect(before.video).toBeLessThan(before.audio * 0.7);
    expect(await retimeVideoToAudio(path)).toBe(true);
    const after = durations(path);
    expect(Math.abs(after.video - after.audio)).toBeLessThan(0.3);
    expect(videoTimeBase(path)).toBe("1/1000");
  });
  it("leaves a correctly timed export untouched", async () => {
    const path = await clip("ok.mp4", false), bytes = readFileSync(path);
    expect(await retimeVideoToAudio(path)).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("joins a retimed piece between normal ones at the right length", async () => {
    const a = await clip("a.mp4", false), b = await clip("b.mp4", true), c = await clip("c.mp4", false), out = join(dir, "joined.mp4");
    await retimeVideoToAudio(b);
    await joinParts([{ path: a }, { path: b }, { path: c }], out);
    expect(Math.abs(formatDuration(out) - 36)).toBeLessThan(0.5);
  });
  it("joins pieces whose video timescales differ", async () => {
    const a = await clip("d.mp4", false), b = join(dir, "e.mp4"), out = join(dir, "joined2.mp4");
    await ffmpeg(["-i", await clip("e0.mp4", false), "-map", "0", "-c", "copy", "-video_track_timescale", "16000", "-f", "mp4", "-y", b]);
    expect(videoTimeBase(b)).toBe("1/16000");
    await joinParts([{ path: a }, { path: b }, { path: await clip("f.mp4", false) }], out);
    expect(Math.abs(formatDuration(out) - 36)).toBeLessThan(0.5);
  });
});
