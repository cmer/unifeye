/**
 * How well the product lays high-resolution GOPs over the low-resolution file, checked against the
 * burned-in clock of each high keyframe and of the low frame it was laid on. Runs the product's
 * placement (`placeStretch`) and reads its trace.
 *
 *   pnpm tsx scripts/adaptive-eval/placement.mts [<setting>=<value> ...] <dataset>...
 *
 * Settings override `PLACEMENT` (src/server/media/placement/index.ts) by dotted path, for example
 * `match.threshold=0.75`, `holes.open=1.2`, `clock.offJump=2`, `jumpRatio=4` or `thumb=96x72`.
 *
 * Per GOP whose keyframe clock could be read:
 *   correct    placed on a low frame whose clock is within 1 s of its own
 *   wrong      placed on a low frame showing another moment
 *   missed     left unplaced although the low file shows that moment (it will play twice)
 *   insert-ok  left unplaced, and the low file does not show that moment (right: it becomes an insert)
 * "present" counts GOPs whose moment the low file shows. The separability margin is, for each present
 * GOP, the best score among low frames of its own second minus the best score more than 3 s away:
 * negative means the pictures alone cannot tell the right moment apart.
 */
import { args, fmt, labels, placeDataset, settingsFrom, verbose } from "./dataset.mjs";

const { sets, opts } = args(), settings = settingsFrom(opts);

const zero = () => ({ gops: 0, correct: 0, wrong: 0, missed: 0, insertOk: 0, unlabelled: 0, present: 0 });
const tot = zero(), margins: number[] = [];
for (const d of sets) {
  const lo = labels(d, "lo"), hi = labels(d, "hi");
  const { high, hi: hg, frames: lt, ms } = await placeDataset(d, settings);
  const { matched: at, similar, keys } = high;
  const m = lt.t.length, have = new Set(lo.filter((x) => x != null));
  const r = zero(), lines: string[] = [];
  hg.gops.forEach((_, i) => {
    r.gops++;
    const k = keys[i], s = k == null ? null : hi[k];
    if (s == null) { r.unlabelled++; return; }
    const present = have.has(s);
    if (present) r.present++;
    let inBest = -2, outBest = -2;
    for (let j = 0; j < m; j++) {
      const l = lo[j];
      if (l == null) continue;
      const v = similar(i, lt.t[j]);
      if (l === s) inBest = Math.max(inBest, v); else if (Math.abs(l - s) > 3) outBest = Math.max(outBest, v);
    }
    if (present) margins.push(inBest - outBest);
    const j = at[i] == null ? -1 : lt.t.findIndex((t) => Math.abs(t - at[i]!) < 1e-6), got = j < 0 ? null : lo[j];
    let verdict: string;
    if (j >= 0) { if (got != null && Math.abs(got - s) <= 1) { r.correct++; verdict = "ok"; } else { r.wrong++; verdict = "WRONG"; } }
    else if (present) { r.missed++; verdict = "missed"; } else { r.insertOk++; verdict = "insert"; }
    lines.push(`   ${String(i).padStart(3)} hi ${fmt(s)} -> ${j >= 0 ? `lo@${lt.t[j].toFixed(2)} ${fmt(got)}` : "      -           "} in ${inBest.toFixed(3)} out ${outBest.toFixed(3)} ${present ? "present" : "absent "} ${verdict}`);
  });
  console.log(`${d.name}: ${r.gops} GOPs, ${r.present} present in low; correct ${r.correct}, wrong ${r.wrong}, missed ${r.missed}, insert-ok ${r.insertOk}, unlabelled ${r.unlabelled} (${ms.toFixed(0)} ms, ${m} low frames)`);
  if (verbose) console.log(lines.join("\n"));
  for (const k of Object.keys(tot) as (keyof typeof tot)[]) tot[k] += r[k];
}
margins.sort((a, b) => a - b);
const q = (p: number) => margins[Math.floor(p * (margins.length - 1))]?.toFixed(3);
console.log(`TOTAL ${JSON.stringify(tot)}\nseparability margin p05 ${q(0.05)} p25 ${q(0.25)} p50 ${q(0.5)}, negative ${margins.filter((x) => x < 0).length}/${margins.length}`);
