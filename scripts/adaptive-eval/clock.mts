/**
 * How close the wall-clock times the product gives keyframes come to the burned-in clock. Runs the
 * product's placement (`placeStretch`) and reads the keyframe times from its trace.
 *
 *   pnpm tsx scripts/adaptive-eval/clock.mts [<setting>=<value> ...] <dataset>...     V=1 per-keyframe detail
 *
 * Settings override `PLACEMENT` as in `placement.mts`.
 *
 * Base: each low keyframe's time against its clock, as the spread around the dataset's median offset
 * (cameras' clocks are off by a steady few seconds, which does not matter for playback).
 * High: the high keyframe times (placed GOPs pin them) against the high clock, the same way.
 */
import { args, labels, placeDataset, settingsFrom, verbose } from "./dataset.mjs";

const { sets, opts } = args(), settings = settingsFrom(opts);
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const all: number[] = [];
for (const d of sets) {
  const midnight = d.midnightMs, lo = labels(d, "lo"), hi = labels(d, "hi");
  const { trace, high, lo: lg, hi: hg } = await placeDataset(d, settings);
  const errs: number[] = [], line: string[] = [];
  lg.gops.forEach((g, k) => {
    const j = trace.baseFrames[k], c = j == null ? null : lo[j];
    if (c == null) { line.push(`${g.t.toFixed(0)}:?`); return; }
    const e = (trace.baseTimes[k] - midnight) / 1000 - c;
    errs.push(e); line.push(`${g.t.toFixed(0)}:${e.toFixed(0)}`);
  });
  const med = [...errs].sort((a, b) => a - b)[errs.length >> 1], dev = errs.map((e) => Math.abs(e - med)).sort((a, b) => a - b);
  console.log(`${d.name} base: median offset ${med.toFixed(1)} s; |dev| p50 ${pct(dev, 0.5).toFixed(1)} p90 ${pct(dev, 0.9).toFixed(1)} max ${dev[dev.length - 1].toFixed(1)}`);
  if (verbose) console.log("   " + line.join(" "));
  all.push(...dev);

  const hc: number[] = [];
  hg.gops.forEach((_, k) => { const j = high.keys[k], c = j == null ? null : hi[j]; if (c != null && k > 0) hc.push((high.times[k] - midnight) / 1000 - c); });
  const hm = [...hc].sort((a, b) => a - b)[hc.length >> 1], hdev = hc.map((e) => Math.abs(e - hm)).sort((a, b) => a - b);
  console.log(`   high, against the high clock: median offset ${hm?.toFixed(1)} |dev| p50 ${pct(hdev, 0.5)?.toFixed(1)} p90 ${pct(hdev, 0.9)?.toFixed(1)} max ${hdev[hdev.length - 1]?.toFixed(1)}`);
}
all.sort((a, b) => a - b);
console.log(`ALL base |dev| p50 ${pct(all, 0.5).toFixed(1)} p90 ${pct(all, 0.9).toFixed(1)} p99 ${pct(all, 0.99).toFixed(1)} max ${all[all.length - 1].toFixed(1)}`);
