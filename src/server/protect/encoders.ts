import { readdir } from "node:fs/promises";
import { config } from "../config";
import { log } from "../util";
import { ffmpeg } from "./ffmpeg";

/** Video codecs Unifeye can re-encode to, as FFmpeg names them. Protect records one of these. */
export type Codec = "h264" | "hevc";
export const isCodec = (c: string): c is Codec => c === "h264" || c === "hevc";

/**
 * How FFmpeg encodes with one encoder: options before the input (device setup), the filter that
 * hands it frames in a format it takes, and the output options.
 */
export interface Encoder { name: string; hardware: boolean; input: string[]; filter: string; output: string[] }

const cpu = (codec: Codec): Encoder => codec === "h264"
  ? { name: "libx264", hardware: false, input: [], filter: "format=yuv420p", output: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"] }
  : { name: "libx265", hardware: false, input: [], filter: "format=yuv420p", output: ["-c:v", "libx265", "-preset", "veryfast", "-crf", "26", "-x265-params", "log-level=error"] };

/** Render nodes to try for VAAPI: the configured one, or every one the host passed in. */
async function renderNodes(): Promise<string[]> {
  if (config().VAAPI_DEVICE) return [config().VAAPI_DEVICE!];
  try { return (await readdir("/dev/dri")).filter((f) => f.startsWith("renderD")).sort().map((f) => `/dev/dri/${f}`); } catch { return []; }
}

/**
 * Hardware encoders worth trying, best first. VAAPI covers Intel Quick Sync and AMD on Linux;
 * the frames are decoded and scaled on the CPU (cheap at the sizes involved) and only the encode
 * runs on the GPU, which keeps the command the same across FFmpeg versions and drivers.
 */
async function hardware(codec: Codec, want: string): Promise<Encoder[]> {
  const out: Encoder[] = [];
  if (want === "auto" || want === "vaapi")
    for (const dev of await renderNodes()) out.push({ name: `${codec}_vaapi (${dev})`, hardware: true, input: ["-vaapi_device", dev], filter: "format=nv12,hwupload", output: ["-c:v", `${codec}_vaapi`, "-qp", "24"] });
  if (want === "auto" || want === "nvenc")
    out.push({ name: `${codec}_nvenc`, hardware: true, input: [], filter: "format=yuv420p", output: ["-c:v", `${codec}_nvenc`, "-rc", "vbr", "-cq", "26", "-b:v", "0"] });
  if ((want === "auto" && process.platform === "darwin") || want === "videotoolbox")
    out.push({ name: `${codec}_videotoolbox`, hardware: true, input: [], filter: "format=nv12", output: ["-c:v", `${codec}_videotoolbox`, "-q:v", "60"] });
  return out;
}

/** A short test encode: an encoder that is compiled in may still have no device or driver behind it. */
async function works(e: Encoder): Promise<boolean> {
  try {
    await ffmpeg([...e.input, "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=7:d=1", "-vf", e.filter, ...e.output, "-f", "null", "-"], AbortSignal.timeout(20_000));
    return true;
  } catch { return false; }
}

async function choose(codec: Codec): Promise<Encoder> {
  const want = config().VIDEO_ENCODER;
  if (want !== "cpu") {
    for (const e of await hardware(codec, want)) if (await works(e)) {
      log("info", "clip resizing uses the GPU", { encoder: e.name });
      return e;
    }
    if (want !== "auto") log("warn", "VIDEO_ENCODER does not work on this host, so clip resizing uses the CPU", { encoder: want });
  }
  return cpu(codec);
}

const g = globalThis as { __unifeyeEncoders?: Map<string, Promise<Encoder>> };
/** The encoder to use for `codec`, found once per process (the test encodes take a moment). */
export function encoderFor(codec: Codec): Promise<Encoder> {
  const key = `${codec}|${config().VIDEO_ENCODER}|${config().VAAPI_DEVICE ?? ""}`, cache = (g.__unifeyeEncoders ??= new Map());
  let e = cache.get(key);
  if (!e) cache.set(key, (e = choose(codec)));
  return e;
}
/**
 * Runs an encode with the chosen encoder, and once more on the CPU if a GPU encode fails (a driver
 * can pass the test encode and still reject a real file).
 */
export async function withEncoder<T>(codec: Codec, encode: (e: Encoder) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const enc = await encoderFor(codec);
  try { return await encode(enc); } catch (e) {
    if (signal?.aborted || !enc.hardware) throw e;
    log("warn", "a GPU encode failed; trying the CPU", { encoder: enc.name, error: e });
    return encode(cpu(codec));
  }
}
