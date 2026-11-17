import { spawn } from "node:child_process";
import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Span } from "../media/align";
import type { Encoder } from "./encoders";

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
export const ffprobe = (args: string[], signal?: AbortSignal) => run("ffprobe", args, signal);

interface Probed { codec_type: string; time_base?: string; start_time?: string; duration?: string; nb_read_packets?: string; has_b_frames?: number }

/** `-video_track_timescale` arguments that keep the video track on `timeBase` (e.g. "1/1000"); none if it cannot be read. */
const keepTimescale = (timeBase?: string) => {
  const den = Number(timeBase?.split("/")[1]);
  return Number.isInteger(den) && den > 0 ? ["-video_track_timescale", String(den)] : [];
};

/**
 * Repairs the video clock of a Protect export, in place. Returns true when the file was rewritten.
 *
 * With adaptive recording, Protect stamps the Low channel's frames on the wrong clock (a 7 fps stream
 * comes out as roughly 11 fps), so a 60-second export holds about 38 seconds of video next to 60
 * seconds of audio. A browser plays the video too fast, then holds the last frame until the audio
 * runs out. The audio clock is right, so the video frames are spread evenly across the audio's
 * span. Stream copy only: no re-encode, a few tens of milliseconds per window.
 *
 * The video keeps its original timescale. Left alone, the MP4 muxer raises Protect's 1/1000 to
 * 1/16000, and a long clip's join (`joinParts`) reads every piece on the first piece's timescale: the
 * retimed piece then plays 16 times too long and every piece after it is squeezed into a moment.
 *
 * Only a file with both tracks, no B-frames, and video clearly shorter than audio is touched. Any
 * other file, or any FFmpeg failure, leaves the export as it was.
 */
export async function retimeVideoToAudio(path: string, signal?: AbortSignal): Promise<boolean> {
  const info = JSON.parse((await run("ffprobe", ["-count_packets", "-show_entries", "stream=codec_type,time_base,start_time,duration,nb_read_packets,has_b_frames", "-of", "json", path], signal)).toString()) as { streams?: Probed[] };
  const v = info.streams?.find((s) => s.codec_type === "video"), a = info.streams?.find((s) => s.codec_type === "audio");
  if (!v || !a || v.has_b_frames) return false;
  const vStart = Number(v.start_time), vDur = Number(v.duration), aEnd = Number(a.start_time) + Number(a.duration), frames = Number(v.nb_read_packets);
  if (![vStart, vDur, aEnd, frames].every(Number.isFinite) || frames < 2 || aEnd - vStart < 5) return false;
  const ratio = (aEnd - vStart) / vDur;
  if (ratio < 1.15 || ratio > 4) return false;
  const step = ((aEnd - vStart) / frames).toFixed(6), tmp = `${path}.retime`;
  try {
    await run("ffmpeg", ["-i", path, "-map", "0", "-c", "copy", "-bsf:v", `setts=ts=STARTPTS+N*${step}/TB:duration=${step}/TB`, ...keepTimescale(v.time_base), "-movflags", "+faststart", "-f", "mp4", "-y", tmp], signal);
    await rename(tmp, path);
    return true;
  } catch (e) { await rm(tmp, { force: true }); throw e; }
}

async function videoTimeBase(path: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = JSON.parse((await run("ffprobe", ["-select_streams", "v:0", "-show_entries", "stream=time_base", "-of", "json", path], signal)).toString()) as { streams?: Probed[] };
  return r.streams?.[0]?.time_base;
}

export interface MediaInfo { start: number; duration: number; width: number; audio: boolean }
/** Container start time and duration (seconds), video width and whether there is an audio track. */
export async function probe(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const r = JSON.parse((await run("ffprobe", ["-show_entries", "format=start_time,duration:stream=codec_type,width", "-of", "json", path], signal)).toString()) as { format?: { start_time?: string; duration?: string }; streams?: { codec_type: string; width?: number }[] };
  return { start: Number(r.format?.start_time) || 0, duration: Number(r.format?.duration) || 0, width: r.streams?.find((s) => s.codec_type === "video")?.width ?? 0, audio: !!r.streams?.some((s) => s.codec_type === "audio") };
}

export interface Size { w: number; h: number }
/**
 * The video codec and every picture size in a file. A size can only change on a keyframe, so only
 * keyframes are decoded: about a second for five minutes of high-resolution video.
 */
export async function videoSizes(path: string, signal?: AbortSignal): Promise<{ codec: string; sizes: Size[] }> {
  const r = JSON.parse((await run("ffprobe", ["-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "stream=codec_name:frame=width,height", "-of", "json", path], signal)).toString()) as { streams?: { codec_name?: string }[]; frames?: { width?: number; height?: number }[] };
  const seen = new Map<string, Size>();
  for (const f of r.frames ?? []) if (f.width && f.height) seen.set(`${f.width}x${f.height}`, { w: f.width, h: f.height });
  return { codec: r.streams?.[0]?.codec_name ?? "", sizes: [...seen.values()] };
}

/**
 * Re-encodes a file's video at `size`, scaled to fit and centred with black bars when the shape
 * differs (4:3 into 16:9, say). Sound and every other track are copied. Each frame keeps its time,
 * and the video keeps its timescale, so the result joins with the original pieces around it. A
 * size change partway through is handled: FFmpeg rebuilds the scaler and the output stays `size`.
 * No B-frames, like the recorder's own video.
 */
export async function fitVideo(src: string, dest: string, size: Size, enc: Encoder, signal?: AbortSignal) {
  const fit = `scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const tmp = `${dest}.part`, tb = await videoTimeBase(src, signal);
  // `-copyts` keeps the video's offset from the sound; the encoder works on the source's own time
  // base, or FFmpeg rounds every frame onto the first frame rate it sees and moves the rest.
  const timing = ["-fps_mode", "passthrough", ...(tb ? ["-enc_time_base", tb] : []), ...keepTimescale(tb)];
  try {
    await run("ffmpeg", ["-copyts", ...enc.input, "-i", src, "-map", "0", "-c", "copy", "-vf", `${fit},${enc.filter}`, ...enc.output, "-bf", "0", ...timing, "-movflags", "+faststart", "-f", "mp4", "-y", tmp], signal);
    await rename(tmp, dest);
  } catch (e) { await rm(tmp, { force: true }); throw e; }
}

/**
 * One file from an adaptive recording's two exports: the low-resolution `base`, which covers the
 * whole time, with the high-resolution stretches of `high` shown wherever `spans` place them. The
 * result is the high file's size and frame rate, so the base is scaled up (with bars if its shape
 * differs) and its frames repeated, and it keeps the base's sound, which has no gaps.
 *
 * Span times count from each file's first sound sample, as the audio match does, so they are moved
 * onto each file's own clock. One FFmpeg run: the high frames are picked by span and retimed onto
 * the base's clock, then laid over the base only inside their spans.
 */
export async function overlayStretches(base: string, high: string, spans: Span[], dest: string, enc: Encoder, signal?: AbortSignal) {
  type S = { codec_type: string; start_time?: string; avg_frame_rate?: string; r_frame_rate?: string };
  const streams = async (p: string) => (JSON.parse((await run("ffprobe", ["-show_entries", "stream=codec_type,start_time,avg_frame_rate,r_frame_rate", "-of", "json", p], signal)).toString()) as { streams?: S[] }).streams ?? [];
  const [bs, hs, { sizes }, tb] = await Promise.all([streams(base), streams(high), videoSizes(high, signal), videoTimeBase(base, signal)]);
  const size = sizes.reduce((m, s) => (s.w * s.h > m.w * m.h ? s : m), { w: 0, h: 0 });
  if (!size.w) throw new Error("the high-resolution export has no video");
  const audioStart = (s: S[]) => Number(s.find((x) => x.codec_type === "audio")?.start_time) || 0;
  const rate = (s: S[]) => { const v = s.find((x) => x.codec_type === "video"); for (const r of [v?.avg_frame_rate, v?.r_frame_rate]) { const [n, d] = (r ?? "").split("/").map(Number); if (n > 0 && d > 0 && n / d <= 60) return n / d; } return 15; };
  const hb = audioStart(hs), bb = audioStart(bs), n = (x: number) => x.toFixed(3);
  const m = spans.map((s) => ({ a: s.from + hb, b: s.from + s.len + hb, shift: s.at + bb - (s.from + hb) }));
  // Commas inside an expression are escaped so the filtergraph does not split on them.
  const within = (v: string, a: number, b: number) => `between(${v}\\,${n(a)}\\,${n(b)})`;
  const pick = m.map((s) => within("t", s.a, s.b)).join("+");
  const retime = m.reduceRight((rest, s) => `if(${within("T", s.a, s.b)}\\,PTS+${n(s.shift)}/TB\\,${rest})`, "PTS");
  const show = m.map((s) => within("t", s.a + s.shift, s.b + s.shift)).join("+");
  const fit = `scale=${size.w}:${size.h}:force_original_aspect_ratio=decrease,pad=${size.w}:${size.h}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const graph = `[0:v]fps=${rate(hs).toFixed(3)},${fit}[b];[1:v]select=${pick},setpts=${retime},${fit}[h];[b][h]overlay=eof_action=pass:enable=${show},${enc.filter}[v]`;
  const tmp = `${dest}.part`;
  try {
    await run("ffmpeg", ["-copyts", ...enc.input, "-i", base, "-i", high, "-filter_complex", graph, "-map", "[v]", "-map", "0:a?", "-c:a", "copy", ...enc.output, "-bf", "0", ...keepTimescale(tb), "-movflags", "+faststart", "-f", "mp4", "-y", tmp], signal);
    await rename(tmp, dest);
  } catch (e) { await rm(tmp, { force: true }); throw e; }
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
 *
 * FFmpeg's concat reads every part on the first part's timescales, so a part with a different video
 * timescale is first rewritten (stream copy) to match. Otherwise its frames land at the wrong times
 * and every later part is squeezed together, which makes the clip far too long and unplayable.
 */
export async function joinParts(parts: { path: string; outpoint?: number }[], dest: string, signal?: AbortSignal) {
  const tb = await Promise.all(parts.map((p) => videoTimeBase(p.path, signal)));
  for (let i = 1; i < parts.length; i++) {
    if (!tb[0] || !tb[i] || tb[i] === tb[0]) continue;
    const tmp = `${parts[i].path}.ts.mp4`;
    try {
      await run("ffmpeg", ["-i", parts[i].path, "-map", "0", "-c", "copy", ...keepTimescale(tb[0]), "-f", "mp4", "-y", tmp], signal);
      await rename(tmp, parts[i].path);
    } catch (e) { await rm(tmp, { force: true }); throw e; }
  }
  // FFmpeg reads relative entries against the list's own folder, so every path is made absolute.
  const list = `${dest}.txt`, q = (p: string) => `'${resolve(p).replace(/'/g, "'\\''")}'`;
  await writeFile(list, parts.map((p) => `file ${q(p.path)}\n${p.outpoint != null ? `outpoint ${p.outpoint.toFixed(3)}\n` : ""}`).join(""), { mode: 0o600 });
  try {
    await run("ffmpeg", ["-f", "concat", "-safe", "0", "-i", list, "-map", "0", "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "-y", dest], signal);
  } finally { await rm(list, { force: true }); }
}
