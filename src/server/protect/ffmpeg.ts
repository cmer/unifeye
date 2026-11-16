import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

export interface MediaInfo { start: number; duration: number; width: number; audio: boolean }
/** Container start time and duration (seconds), video width and whether there is an audio track. */
export async function probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const r = JSON.parse((await run("ffprobe", ["-show_entries", "format=start_time,duration:stream=codec_type,width", "-of", "json", path], signal)).toString()) as { format?: { start_time?: string; duration?: string }; streams?: { codec_type: string; width?: number }[] };
  return { start: Number(r.format?.start_time) || 0, duration: Number(r.format?.duration) || 0, width: r.streams?.find((s) => s.codec_type === "video")?.width ?? 0, audio: !!r.streams?.some((s) => s.codec_type === "audio") };
}

/** Loudness of the first audio track every 10 ms (log energy at 8 kHz mono), for lining up two exports of the same recording. */
export async function audioEnvelope(path: string, signal?: AbortSignal): Promise<Float64Array> {
  const pcm = await run("ffmpeg", ["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "8000", "-f", "f32le", "pipe:1"], signal);
  const bytes = Math.floor(pcm.length / 4) * 4, x = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + bytes)), HOP = 80, n = Math.floor(x.length / HOP), e = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let j = i * HOP; j < (i + 1) * HOP; j++) s += x[j] * x[j]; e[i] = Math.log(1e-9 + s / HOP); }
  return e;
}

/**
 * Joins exports of consecutive stretches into one MP4, stream copy only. `outpoint` (seconds, on the
 * part's own clock) drops the tail of a part that the next part repeats: the recorder starts each
 * export on the keyframe before the requested time, so neighbours overlap by up to a few seconds.
 */
export async function joinParts(parts: { path: string; outpoint?: number }[], dest: string, signal?: AbortSignal) {
  // FFmpeg reads relative entries against the list's own folder, so every path is made absolute.
  const list = `${dest}.txt`, q = (p: string) => `'${resolve(p).replace(/'/g, "'\\''")}'`;
  await writeFile(list, parts.map((p) => `file ${q(p.path)}\n${p.outpoint != null ? `outpoint ${p.outpoint.toFixed(3)}\n` : ""}`).join(""), { mode: 0o600 });
  try {
    await run("ffmpeg", ["-f", "concat", "-safe", "0", "-i", list, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "-y", dest], signal);
  } finally { await rm(list, { force: true }); }
}
