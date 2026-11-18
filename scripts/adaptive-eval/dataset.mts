/**
 * One dataset of the adaptive matching harness (see README.md): a folder from the private footage
 * repository holding one window of an adaptive-recording camera.
 *
 *   lo.mp4, hi.mp4    the recorder's exports of the low (channel 2) and high (channel 0) resolution
 *   segs.json         the recorder's segment lists for both channels: { lo: [[a, b]...], hi: [...] }
 *   meta.json         camera, window, time zone and where the camera draws its clock (`Meta`)
 *   labels_lo.json    the burned-in clock of every low frame, in seconds since local midnight (or null)
 *   labels_hi.json    the same for every high keyframe; both written by `label.mts`
 *
 * The clock readings are for checking results only. The product never reads a burned-in clock.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { PLACEMENT, placeStretch, type PlacementSettings } from "@/server/media/placement";
import { gopsOf, thumbnails } from "@/server/protect/ffmpeg";

export interface Meta {
  camera: { id: string; name: string };
  /** The window that was exported, in ms since the epoch. */
  startMs: number;
  endMs: number;
  /** The camera clock's offset from UTC at that time, in minutes (-300 for UTC-5). */
  utcOffsetMinutes: number;
  /** FFmpeg crops around the burned-in clock in each file, for `label.mts`. */
  clockCrop: { lo: string; hi: string };
  notes?: string;
}

export interface Dataset {
  name: string;
  dir: string;
  meta: Meta;
  lo: string;
  hi: string;
  segs: { lo: [number, number][]; hi: [number, number][] };
  /** Local midnight of the window's day, in ms since the epoch: labels count seconds from here. */
  midnightMs: number;
}

const DAY = 86_400_000;

export function load(dir: string): Dataset {
  dir = resolve(dir);
  const read = (f: string) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8"));
  const meta: Meta = read("meta.json");
  const local = meta.startMs + meta.utcOffsetMinutes * 60_000;
  return { name: basename(dir), dir, meta, lo: `${dir}/lo.mp4`, hi: `${dir}/hi.mp4`, segs: read("segs.json"), midnightMs: local - (local % DAY) - meta.utcOffsetMinutes * 60_000 };
}

/** The clock readings `label.mts` saved; fails with a hint when they are missing. */
export function labels(d: Dataset, which: "lo" | "hi"): (number | null)[] {
  const f = `${d.dir}/labels_${which}.json`;
  if (!existsSync(f)) throw new Error(`${d.name}: no clock readings yet; run label.mts on it first (macOS)`);
  return JSON.parse(readFileSync(f, "utf8"));
}

/** Dataset folders from the command line, after any `key=value` options. */
export function args(argv = process.argv.slice(2)): { sets: Dataset[]; opts: Record<string, string> } {
  const opts: Record<string, string> = {}, sets: Dataset[] = [];
  for (const a of argv) {
    const m = /^([\w.]+)=(.*)$/.exec(a);
    if (m) opts[m[1]] = m[2];
    else sets.push(load(a));
  }
  if (!sets.length) { console.error("usage: tsx <script> [key=value ...] <dataset dir>..."); process.exit(2); }
  return { sets, opts };
}

/**
 * The product's settings (`PLACEMENT`) with overrides from the command line: a dotted path to a
 * number (`match.threshold=0.75`, `holes.open=1.2`, `jumpRatio=4`) or `thumb=96x72`.
 */
export function settingsFrom(opts: Record<string, string>): PlacementSettings {
  const s = structuredClone(PLACEMENT);
  for (const [k, v] of Object.entries(opts)) {
    if (k === "thumb") { const [w, h] = v.split("x").map(Number); s.thumb = { w, h }; continue; }
    const path = k.split("."), last = path.pop()!;
    let o: Record<string, unknown> | undefined = s as unknown as Record<string, unknown>;
    for (const p of path) o = o?.[p] as Record<string, unknown> | undefined;
    if (typeof o?.[last] !== "number") throw new Error(`unknown setting ${k}; see PLACEMENT in src/server/media/placement/index.ts`);
    o[last] = Number(v);
  }
  return s;
}

/**
 * Reads a dataset's files and places them through the product's own interface (`placeStretch`), as
 * `fetchRecorded` does. One step is skipped: the product first repairs a low file whose video clock
 * runs fast (`retimeVideoToAudio`); the baseline was measured without it.
 */
export async function placeDataset(d: Dataset, settings: PlacementSettings = PLACEMENT) {
  const [lo, hi] = await Promise.all([gopsOf(d.lo), gopsOf(d.hi)]);
  const [frames, keys] = await Promise.all([thumbnails(d.lo, { keyframes: false, ...settings.thumb }), thumbnails(d.hi, { keyframes: true, ...settings.thumb })]);
  const t0 = performance.now();
  const placed = placeStretch({ startMs: d.meta.startMs, endMs: d.meta.endMs }, { gops: lo.gops, end: lo.end, segments: d.segs.lo, frames }, { gops: hi.gops, end: hi.end, segments: d.segs.hi, keys }, settings);
  return { ...placed, high: placed.trace.high!, ms: performance.now() - t0, lo, hi, frames, keys };
}

/** Seconds since midnight as hh:mm:ss. */
export function fmt(s: number | null | undefined): string {
  if (s == null) return "  --  ";
  const r = Math.round(s), two = (n: number) => String(n).padStart(2, "0");
  return `${two(Math.floor(r / 3600))}:${two(Math.floor(r / 60) % 60)}:${two(r % 60)}`;
}

/** Verbose output (V=1). */
export const verbose = !!process.env.V;
