/**
 * Reads the burned-in clock off every low frame and every high keyframe of a dataset and saves it as
 * labels_lo.json / labels_hi.json (seconds since local midnight, null where unreadable). The labels are
 * the answer key for the other scripts; commit them to the footage repository with the dataset.
 * macOS only (uses Vision through ocr.swift, built on first use with swiftc).
 *
 *   pnpm tsx scripts/adaptive-eval/label.mts [force=1] <dataset>...
 *
 * `meta.json` says where each file draws its clock (`clockCrop`, an FFmpeg crop). To find it for a new
 * camera, grab a frame (ffmpeg -i lo.mp4 -frames:v 1 f.png), note the clock's box, and check a few
 * frames with the crop before labelling. Frames are stacked 40 to a sheet so the recogniser sees each
 * clock on its own row. A high clock read as minutes and seconds only takes its hour from the low one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, fmt, type Dataset } from "./dataset.mjs";

const ROWS = 40, here = new URL(".", import.meta.url).pathname;
const sh = (cmd: string, a: string[]) => execFileSync(cmd, a, { maxBuffer: 1 << 30 });

function ocrBinary(): string {
  const dir = join(here, "../../node_modules/.cache/adaptive-eval"), bin = join(dir, "ocr"), src = join(here, "ocr.swift");
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) { mkdirSync(dir, { recursive: true }); sh("swiftc", ["-O", src, "-o", bin]); }
  return bin;
}

function read(d: Dataset, which: "lo" | "hi", hour?: number): (number | null)[] {
  const tmp = mkdtempSync(join(tmpdir(), "adaptive-eval-ocr-"));
  try {
    const crop = d.meta.clockCrop[which];
    if (!crop) throw new Error(`${d.name}: set meta.json clockCrop.${which} first (an FFmpeg crop around the clock)`);
    // Low clocks are small: enlarge them. High clocks are white on a busy picture: keep the white only.
    const vf = which === "lo" ? `${crop},scale=240:66:flags=bicubic,pad=300:70:20:2:white,tile=1x${ROWS}` : `${crop},format=gray,lut=y='if(gt(val\\,225)\\,0\\,255)',scale=200:41:flags=area,pad=300:70:30:14:white,tile=1x${ROWS}`;
    sh("ffmpeg", ["-v", "error", ...(which === "hi" ? ["-skip_frame", "nokey"] : []), "-i", which === "lo" ? d.lo : d.hi, "-an", "-vf", vf, "-fps_mode", "passthrough", `${tmp}/s_%05d.png`]);
    const files = readdirSync(tmp).filter((f) => f.endsWith(".png")).sort();
    const out: (number | null)[] = [];
    for (const line of sh(ocrBinary(), [String(ROWS), ...files.map((f) => `${tmp}/${f}`)]).toString().trim().split("\n")) {
      const [path, row, text = ""] = line.split("\t");
      const hms = /(\d\d):(\d\d):(\d\d)/.exec(text), ms = /(\d\d):(\d\d)\D*$/.exec(text);
      if (!hms && !(ms && hour != null)) continue;
      const idx = files.indexOf(path.slice(tmp.length + 1)) * ROWS + Number(row);
      out[idx] = hms ? Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]) : hour! * 3600 + Number(ms![1]) * 60 + Number(ms![2]);
    }
    return Array.from(out, (v) => v ?? null);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

const { sets, opts } = args();
for (const d of sets) {
  const f = (w: string) => `${d.dir}/labels_${w}.json`;
  if (!opts.force && existsSync(f("lo")) && existsSync(f("hi"))) { console.log(`${d.name}: already labelled (force=1 to redo)`); continue; }
  const lo = read(d, "lo"), first = lo.find((x) => x != null);
  const hi = read(d, "hi", first == null ? undefined : Math.floor(first / 3600));
  writeFileSync(f("lo"), JSON.stringify(lo));
  writeFileSync(f("hi"), JSON.stringify(hi));
  const n = (xs: (number | null)[]) => xs.filter((x) => x != null).length;
  console.log(`${d.name}: low ${n(lo)}/${lo.length} frames read, ${fmt(first)} to ${fmt(lo.findLast((x) => x != null))}; high ${n(hi)}/${hi.length} keyframes read`);
}
