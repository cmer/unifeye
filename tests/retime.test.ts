import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ffmpeg, retimeVideoToAudio } from "../src/server/protect/ffmpeg";

const hasFfmpeg = spawnSync("ffprobe", ["-version"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "vantage-retime-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const durations = (path: string) => {
  const out = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,duration", "-of", "json", path]).toString()) as { streams: { codec_type: string; duration: string }[] };
  return Object.fromEntries(out.streams.map((s) => [s.codec_type, Number(s.duration)]));
};
/** 12 s of 7 fps video and 12 s of audio; `fast` stamps the video at 11 fps, as Protect does for an adaptive Low channel. */
async function clip(name: string, fast: boolean) {
  const path = join(dir, name);
  await ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x240:r=7:d=12", "-f", "lavfi", "-i", "sine=d=12:sample_rate=16000", "-c:v", "libx264", "-preset", "ultrafast", "-bf", "0", "-g", "28", "-c:a", "aac",
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
  });
  it("leaves a correctly timed export untouched", async () => {
    const path = await clip("ok.mp4", false), bytes = readFileSync(path);
    expect(await retimeVideoToAudio(path)).toBe(false);
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
});
