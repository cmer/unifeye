/**
 * With the recorder's stamps (`stamps.json`): how close the time given to each high GOP is to the
 * clock drawn on its keyframe, and how late its stamp ran. The base's stamps are checked the same way.
 *
 *   pnpm tsx scripts/adaptive-eval/lag.mts [key=value ...] <dataset>...     V=1 lists every GOP
 */
import { args, fmt, labels, placeDataset, settingsFrom, verbose } from "./dataset.mjs";

const { sets, opts } = args(), settings = settingsFrom(opts);
const q = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
const all: number[] = [], lateAll: number[] = [];
for (const d of sets) {
  if (!d.stamps) { console.log(`${d.name}: no stamps.json`); continue; }
  const lo = labels(d, "lo"), hi = labels(d, "hi");
  const { trace, high } = await placeDataset(d, settings);
  const secs = (ms: number) => (ms - d.midnightMs) / 1000;
  // The base: stamp minus clock at each keyframe. A clock shows whole seconds, so a steady 0 to 1 s is exact.
  const baseOff = trace.baseTimes.flatMap((t, k) => { const f = trace.baseFrames[k], c = f == null ? null : lo[f]; return c == null ? [] : [secs(t) - c]; });
  const usual = q(baseOff, 0.5);
  const errs: number[] = [];
  high.times.forEach((t, g) => {
    const key = high.keys[g], c = key == null ? null : hi[key];
    if (c == null) return;
    const err = secs(t) - c - usual;
    errs.push(Math.abs(err));
    if (verbose) console.log(`   #${String(g).padStart(2)} clock ${fmt(c)} placed ${fmt(secs(t) - usual)} (${err >= 0 ? "+" : ""}${err.toFixed(1)} s) lag ${high.lag?.[g].toFixed(1)} s ${high.matched[g] != null ? "seen in base" : ""}`);
  });
  // How late the recorder's stamps for the high GOPs really ran, by the clock.
  const late = d.stamps.hi.flatMap((t, g) => { const key = high.keys[g], c = key == null ? null : hi[key]; return c == null ? [] : [secs(t) - c - usual]; }).filter((x) => Math.abs(x) < 110);
  lateAll.push(...late);
  all.push(...errs);
  const within = (s: number) => errs.filter((e) => e <= s).length;
  console.log(`${d.name}: base stamps run ${usual.toFixed(1)} s past the clock (${q(baseOff, 0.05).toFixed(1)} to ${q(baseOff, 0.95).toFixed(1)}); ${errs.length} high GOPs: ${within(1.5)} within 1.5 s, ${within(4)} within 4 s, worst ${Math.max(0, ...errs).toFixed(1)} s; high stamps ran ${q(late, 0).toFixed(0)} to ${q(late, 0.999).toFixed(0)} s late (median ${q(late, 0.5).toFixed(0)})`);
}
console.log(`TOTAL ${all.length} high GOPs: ${all.filter((e) => e <= 1.5).length} within 1.5 s, ${all.filter((e) => e <= 4).length} within 4 s, median ${q(all, 0.5).toFixed(1)} s, p90 ${q(all, 0.9).toFixed(1)} s, worst ${Math.max(0, ...all).toFixed(1)} s`);
console.log(`High stamps ran late by ${q(lateAll, 0.5).toFixed(1)} s at the median, ${q(lateAll, 0.9).toFixed(1)} s at p90, ${q(lateAll, 0.99).toFixed(1)} s at p99, ${Math.max(...lateAll).toFixed(1)} s at most`);
