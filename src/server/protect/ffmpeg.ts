import { spawn } from "node:child_process";
import { rename, rm } from "node:fs/promises";

function run(cmd: "ffmpeg" | "ffprobe", args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, ["-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "pipe", "pipe"], signal });
    const out: Buffer[] = []; let err = "";
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 300)}`))));
  });
}
export const ffmpeg = (args: string[], signal?: AbortSignal) => run("ffmpeg", args, signal);

interface Probed { codec_type: string; start_time?: string; duration?: string; nb_read_packets?: string; has_b_frames?: number }

/**
 * Repairs the video clock of a Protect export, in place. Returns true when the file was rewritten.
 *
 * With adaptive recording, Protect stamps the Low channel's frames on the wrong clock (a 7 fps stream
 * comes out as roughly 11 fps), so a 60-second export holds about 38 seconds of video next to 60
 * seconds of audio. A browser plays the video too fast, then holds the last frame until the audio
 * runs out. The audio clock is right, so the video frames are spread evenly across the audio's
 * span. Stream copy only: no re-encode, a few tens of milliseconds per window.
 *
 * Only a file with both tracks, no B-frames, and video clearly shorter than audio is touched. Any
 * other file, or any FFmpeg failure, leaves the export as it was.
 */
export async function retimeVideoToAudio(path: string, signal?: AbortSignal): Promise<boolean> {
  const info = JSON.parse((await run("ffprobe", ["-count_packets", "-show_entries", "stream=codec_type,start_time,duration,nb_read_packets,has_b_frames", "-of", "json", path], signal)).toString()) as { streams?: Probed[] };
  const v = info.streams?.find((s) => s.codec_type === "video"), a = info.streams?.find((s) => s.codec_type === "audio");
  if (!v || !a || v.has_b_frames) return false;
  const vStart = Number(v.start_time), vDur = Number(v.duration), aEnd = Number(a.start_time) + Number(a.duration), frames = Number(v.nb_read_packets);
  if (![vStart, vDur, aEnd, frames].every(Number.isFinite) || frames < 2 || aEnd - vStart < 5) return false;
  const ratio = (aEnd - vStart) / vDur;
  if (ratio < 1.15 || ratio > 4) return false;
  const step = ((aEnd - vStart) / frames).toFixed(6), tmp = `${path}.retime`;
  try {
    await run("ffmpeg", ["-i", path, "-map", "0", "-c", "copy", "-bsf:v", `setts=ts=STARTPTS+N*${step}/TB:duration=${step}/TB`, "-movflags", "+faststart", "-f", "mp4", "-y", tmp], signal);
    await rename(tmp, path);
    return true;
  } catch (e) { await rm(tmp, { force: true }); throw e; }
}
